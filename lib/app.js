// Lógica do OKAY Check-in, independente de onde roda.
// Recebe um Request (Web API) e devolve um Response. Usado pelo servidor Node
// (server.js, com armazenamento em disco) e pela função do Netlify (Netlify Blobs).
import crypto from 'node:crypto';
import { limparCpf, cpfValido, mascararCpf, consultarCpf } from './cpf.js';
import { TERMO_PADRAO } from './termo-padrao.js';

const LOCAIS_PADRAO = [
  { id: 'recepcao', nome: 'Recepção OKAY', capacidade: 10 },
  { id: 'sala-reuniao-1', nome: 'Sala de Reunião 1', capacidade: 8 },
  { id: 'sala-reuniao-2', nome: 'Sala de Reunião 2', capacidade: 6 },
];
const VALIDADE_CONSULTA_MS = 2 * 60 * 60 * 1000; // tempo para concluir o check-in após consultar o CPF

/**
 * storage: {
 *   getText(key) -> string|null, setText(key, text),
 *   getJSON(key) -> any|null,    setJSON(key, value),
 *   getBinary(key) -> {data: Uint8Array, contentType}|null, setBinary(key, data, contentType),
 *   addCheckin(registro), listCheckins() -> registro[] (mais recentes primeiro)
 * }
 */
export function criarApp({ storage, env = process.env, log = console }) {
  const ADMIN_USER = env.ADMIN_USER || 'admin';
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
  const manualPermitido = env.ALLOW_MANUAL_NAME === 'true';

  // ------------------------------------------------------------ segredo
  let segredo = env.QR_SECRET || null;
  async function obterSegredo() {
    if (segredo) return segredo;
    segredo = (await storage.getText('secret.txt'))?.trim() || null;
    if (!segredo) {
      segredo = crypto.randomBytes(32).toString('hex');
      await storage.setText('secret.txt', segredo);
    }
    return segredo;
  }
  const hmac = async (txt) => crypto.createHmac('sha256', await obterSegredo()).update(txt).digest('base64url');
  // IDs de espaço são [a-z0-9-] (sem ":"), então nunca colidem com o prefixo "cpf:" dos comprovantes.
  const assinarLocal = async (id) => (await hmac(id)).slice(0, 22);

  function iguais(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  // ------------------------------------------------------------ dados
  async function locais() {
    const l = await storage.getJSON('locais.json');
    if (l) return l;
    await storage.setJSON('locais.json', LOCAIS_PADRAO);
    return LOCAIS_PADRAO;
  }
  const termo = async () => (await storage.getText('termo.md')) || TERMO_PADRAO;

  async function validarQr(l, k) {
    if (typeof l !== 'string' || typeof k !== 'string') return null;
    const local = (await locais()).find((x) => x.id === l);
    if (!local) return null;
    return iguais(k, await assinarLocal(local.id)) ? local : null;
  }

  // Comprovante assinado da consulta de CPF: o navegador devolve no check-in e o
  // servidor confere a assinatura. Assim o nome nunca vem do navegador.
  async function emitirComprovante(p) {
    const corpo = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + VALIDADE_CONSULTA_MS })).toString('base64url');
    return `${corpo}.${await hmac(`cpf:${corpo}`)}`;
  }
  async function lerComprovante(token) {
    if (typeof token !== 'string') return null;
    const [corpo, assinatura] = token.split('.');
    if (!corpo || !assinatura || !iguais(assinatura, await hmac(`cpf:${corpo}`))) return null;
    try {
      const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
      return p.exp > Date.now() && cpfValido(p.cpf) ? p : null;
    } catch { return null; }
  }

  // ------------------------------------------------------- rate limiting
  const tentativas = new Map();
  function limitar(ip, max = 30, janelaMs = 10 * 60 * 1000) {
    const agora = Date.now();
    const lista = (tentativas.get(ip) || []).filter((t) => agora - t < janelaMs);
    lista.push(agora);
    tentativas.set(ip, lista);
    if (tentativas.size > 5000) tentativas.clear();
    return lista.length > max;
  }

  // ------------------------------------------------------------ helpers
  const json = (status, corpo) => new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

  async function lerCorpo(request, limite) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > limite) throw Object.assign(new Error('Requisição muito grande'), { status: 413 });
    try { return JSON.parse(new TextDecoder().decode(buf) || '{}'); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
  }

  function adminAutorizado(request) {
    if (!ADMIN_PASSWORD) return false;
    const h = request.headers.get('authorization') || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    return iguais(u, ADMIN_USER) & iguais(p.join(':'), ADMIN_PASSWORD);
  }
  const negarAdmin = () => new Response(ADMIN_PASSWORD ? 'Autenticação necessária' : 'Defina ADMIN_PASSWORD para usar o painel', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="OKAY Admin", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' },
  });

  const pessoaPublica = (p) => ({ cpf: p.cpf, cpfMascarado: mascararCpf(p.cpf), nome: p.nome, situacao: p.situacao });

  // -------------------------------------------------------------- rotas
  async function rotas(request, { ip, origem }) {
    const url = new URL(request.url);
    const rota = `${request.method} ${url.pathname}`;

    if (rota === 'GET /api/local') {
      const local = await validarQr(url.searchParams.get('l'), url.searchParams.get('k'));
      if (!local) return json(403, { erro: 'QR Code inválido. Escaneie novamente o QR Code da entrada.' });
      return json(200, { id: local.id, nome: local.nome, capacidade: local.capacidade || 20, nomeManual: manualPermitido });
    }

    if (rota === 'GET /api/termo') {
      return new Response(await termo(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (rota === 'POST /api/cpf') {
      const corpo = await lerCorpo(request, 10 * 1024);
      if (!(await validarQr(corpo.l, corpo.k))) return json(403, { erro: 'QR Code inválido.' });
      if (limitar(ip)) return json(429, { erro: 'Muitas consultas. Aguarde alguns minutos e tente novamente.' });
      const cpf = limparCpf(corpo.cpf);
      if (!cpfValido(cpf)) return json(400, { erro: 'CPF inválido. Confira os números digitados.' });

      if (corpo.nomeManual) {
        if (!manualPermitido) return json(403, { erro: 'Cadastro manual desativado.' });
        const nome = String(corpo.nomeManual).trim().toUpperCase();
        if (nome.split(/\s+/).length < 2 || nome.length > 120) return json(400, { erro: 'Informe o nome completo.' });
        const p = { cpf, nome, situacao: 'Informado manualmente', manual: true };
        return json(200, { ...pessoaPublica(p), token: await emitirComprovante(p) });
      }

      try {
        const r = await consultarCpf(cpf);
        if (!r) return json(404, { erro: 'CPF não encontrado na base da Receita Federal.' });
        const p = { cpf, nome: r.nome, situacao: r.situacao };
        return json(200, { ...pessoaPublica(p), token: await emitirComprovante(p) });
      } catch (e) {
        if (e.bloqueado) return json(403, { erro: e.message });
        log.error('[cpf] falha na consulta:', e.message);
        return json(502, { erro: 'Não foi possível consultar o CPF agora. Tente novamente.', permiteManual: manualPermitido });
      }
    }

    if (rota === 'POST /api/checkin') {
      const corpo = await lerCorpo(request, 6 * 1024 * 1024);
      const local = await validarQr(corpo.l, corpo.k);
      if (!local) return json(403, { erro: 'QR Code inválido.' });
      if (corpo.aceite !== true) return json(400, { erro: 'É necessário aceitar o termo.' });

      const tokens = Array.isArray(corpo.pessoas) ? corpo.pessoas : [];
      if (!tokens.length) return json(400, { erro: 'Informe ao menos o titular.' });
      if (tokens.length > (local.capacidade || 20)) return json(400, { erro: `Capacidade máxima do espaço: ${local.capacidade} pessoas.` });

      const pessoas = [];
      for (const t of tokens) {
        const p = await lerComprovante(t);
        if (!p) return json(400, { erro: 'A consulta de algum CPF expirou. Refaça o check-in.' });
        pessoas.push({ cpf: p.cpf, nome: p.nome, situacao: p.situacao, manual: !!p.manual });
      }
      if (new Set(pessoas.map((p) => p.cpf)).size !== pessoas.length) return json(400, { erro: 'Há CPFs repetidos na lista.' });

      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(corpo.selfie || '');
      if (!m) return json(400, { erro: 'Selfie não recebida.' });
      const img = Buffer.from(m[2], 'base64');
      if (img.length < 2000) return json(400, { erro: 'Selfie inválida.' });

      const agora = new Date().toISOString();
      const id = `${agora.slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
      const arqSelfie = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      await storage.setBinary(`selfies/${arqSelfie}`, img, `image/${m[1]}`);

      const registro = {
        id,
        data: agora,
        local: { id: local.id, nome: local.nome },
        titular: pessoas[0],
        participantes: pessoas.slice(1),
        aceiteTermo: { aceito: true, em: agora, hashTermo: crypto.createHash('sha256').update(await termo()).digest('hex').slice(0, 16) },
        selfie: arqSelfie,
        ip,
        userAgent: request.headers.get('user-agent') || '',
      };
      await storage.addCheckin(registro);
      log.log(`[checkin] ${id} ${local.nome} — ${pessoas.map((p) => p.nome).join(', ')}`);
      return json(201, { id, local: local.nome, nomes: pessoas.map((p) => p.nome) });
    }

    // ---------------------------------------------------------- admin
    if (url.pathname.startsWith('/selfies/')) {
      if (!adminAutorizado(request)) return negarAdmin();
      const nome = url.pathname.split('/').pop();
      if (!/^[\w.-]+$/.test(nome)) return new Response('Não encontrado', { status: 404 });
      const arq = await storage.getBinary(`selfies/${nome}`);
      if (!arq) return new Response('Não encontrado', { status: 404 });
      return new Response(arq.data, { headers: { 'Content-Type': arq.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!adminAutorizado(request)) return negarAdmin();

      if (rota === 'GET /api/admin/locais') {
        const base = (env.PUBLIC_URL || origem).replace(/\/$/, '');
        const lista = await locais();
        return json(200, await Promise.all(lista.map(async (l) => ({ ...l, url: `${base}/?l=${encodeURIComponent(l.id)}&k=${await assinarLocal(l.id)}` }))));
      }

      if (rota === 'POST /api/admin/locais') {
        const corpo = await lerCorpo(request, 10 * 1024);
        const nome = String(corpo.nome || '').trim().slice(0, 80);
        const capacidade = Math.max(1, Math.min(500, Number(corpo.capacidade) || 10));
        if (!nome) return json(400, { erro: 'Informe o nome do espaço.' });
        const id = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!id) return json(400, { erro: 'Nome inválido.' });
        const lista = await locais();
        if (lista.some((l) => l.id === id)) return json(409, { erro: 'Já existe um espaço com esse nome.' });
        await storage.setJSON('locais.json', [...lista, { id, nome, capacidade }]);
        return json(201, { id });
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/api/admin/locais/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        await storage.setJSON('locais.json', (await locais()).filter((l) => l.id !== id));
        return json(200, { ok: true });
      }

      if (rota === 'GET /api/admin/checkins') {
        return json(200, await storage.listCheckins());
      }
    }

    return null; // não é rota da aplicação
  }

  return {
    adminAutorizado,
    negarAdmin,
    /** Devolve Response, ou null se a rota não for da aplicação (arquivos estáticos). */
    async handle(request, { ip = '', origem } = {}) {
      try {
        return await rotas(request, { ip, origem: origem || new URL(request.url).origin });
      } catch (e) {
        log.error(e);
        return json(e.status || 500, { erro: e.status ? e.message : 'Erro interno' });
      }
    },
  };
}

export const CABECALHOS_SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', // não vaza a chave do QR Code para outros sites
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
