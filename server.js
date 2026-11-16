// OKAY Check-in — servidor sem dependências externas (Node 20+).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { limparCpf, cpfValido, mascararCpf, consultarCpf, nomeEmCache, registrarNomeManual } from './lib/cpf.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const SELFIES = path.join(DATA, 'selfies');

// ------------------------------------------------------------------ .env
(function carregarEnv() {
  const arq = path.join(ROOT, '.env');
  if (!fs.existsSync(arq)) return;
  for (const linha of fs.readFileSync(arq, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

fs.mkdirSync(SELFIES, { recursive: true });

function lerJson(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}
function gravarJson(arq, dados) {
  const tmp = arq + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
  fs.renameSync(tmp, arq);
}

const SECRET_FILE = path.join(DATA, 'secret.txt');
const QR_SECRET = process.env.QR_SECRET || (() => {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s);
  return s;
})();

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('base64url');
  console.log(`[admin] ADMIN_PASSWORD não definida. Senha temporária desta execução: ${ADMIN_PASSWORD}`);
}
const ADMIN_USER = process.env.ADMIN_USER || 'admin';

const LOCAIS_FILE = path.join(DATA, 'locais.json');
const CHECKINS_FILE = path.join(DATA, 'checkins.json');
const TERMO_FILE = path.join(DATA, 'termo.md');

if (!fs.existsSync(LOCAIS_FILE)) {
  gravarJson(LOCAIS_FILE, [
    { id: 'recepcao', nome: 'Recepção OKAY', capacidade: 10 },
    { id: 'sala-reuniao-1', nome: 'Sala de Reunião 1', capacidade: 8 },
    { id: 'sala-reuniao-2', nome: 'Sala de Reunião 2', capacidade: 6 },
  ]);
}
if (!fs.existsSync(TERMO_FILE)) fs.copyFileSync(path.join(ROOT, 'lib', 'termo-padrao.md'), TERMO_FILE);

const locais = () => lerJson(LOCAIS_FILE, []);
const assinar = (id) => crypto.createHmac('sha256', QR_SECRET).update(id).digest('base64url').slice(0, 22);

function validarQr(l, k) {
  const local = locais().find((x) => x.id === l);
  if (!local || typeof k !== 'string') return null;
  const esperado = Buffer.from(assinar(local.id));
  const recebido = Buffer.from(k);
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido) ? local : null;
}

// --------------------------------------------------------- rate limiting
const tentativas = new Map();
function limitar(ip, max = 30, janelaMs = 10 * 60 * 1000) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter((t) => agora - t < janelaMs);
  lista.push(agora);
  tentativas.set(ip, lista);
  return lista.length > max;
}

// --------------------------------------------------------------- helpers
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function json(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req, limite = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > limite) { reject(Object.assign(new Error('Requisição muito grande'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function servirArquivo(res, arq, extraHeaders = {}) {
  fs.stat(arq, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq).toLowerCase()] || 'application/octet-stream', ...extraHeaders });
    fs.createReadStream(arq).pipe(res);
  });
}

function adminAutorizado(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const ok = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  return ok(u, ADMIN_USER) & ok(p.join(':'), ADMIN_PASSWORD);
}

function exigirAdmin(req, res) {
  if (adminAutorizado(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OKAY Admin", charset="UTF-8"' });
  res.end('Autenticação necessária');
  return false;
}

const ipDe = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// ------------------------------------------------------------------ rotas
async function api(req, res, url) {
  const rota = `${req.method} ${url.pathname}`;

  if (rota === 'GET /api/local') {
    const local = validarQr(url.searchParams.get('l'), url.searchParams.get('k'));
    if (!local) return json(res, 403, { erro: 'QR Code inválido. Escaneie novamente o QR Code da entrada.' });
    return json(res, 200, { id: local.id, nome: local.nome, capacidade: local.capacidade || 20, nomeManual: process.env.ALLOW_MANUAL_NAME === 'true' });
  }

  if (rota === 'GET /api/termo') {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(TERMO_FILE, 'utf8'));
  }

  if (rota === 'POST /api/cpf') {
    const corpo = await lerCorpo(req, 10 * 1024);
    if (!validarQr(corpo.l, corpo.k)) return json(res, 403, { erro: 'QR Code inválido.' });
    if (limitar(ipDe(req))) return json(res, 429, { erro: 'Muitas consultas. Aguarde alguns minutos e tente novamente.' });
    const cpf = limparCpf(corpo.cpf);
    if (!cpfValido(cpf)) return json(res, 400, { erro: 'CPF inválido. Confira os números digitados.' });

    if (corpo.nomeManual) {
      if (process.env.ALLOW_MANUAL_NAME !== 'true') return json(res, 403, { erro: 'Cadastro manual desativado.' });
      const nome = String(corpo.nomeManual).trim();
      if (nome.split(/\s+/).length < 2 || nome.length > 120) return json(res, 400, { erro: 'Informe o nome completo.' });
      const r = registrarNomeManual(cpf, nome);
      return json(res, 200, { cpf, cpfMascarado: mascararCpf(cpf), nome: r.nome, situacao: r.situacao });
    }

    try {
      const r = await consultarCpf(cpf);
      if (!r) return json(res, 404, { erro: 'CPF não encontrado na base da Receita Federal.' });
      return json(res, 200, { cpf, cpfMascarado: mascararCpf(cpf), nome: r.nome, situacao: r.situacao });
    } catch (e) {
      if (e.bloqueado) return json(res, 403, { erro: e.message });
      console.error('[cpf] falha na consulta:', e.message);
      return json(res, 502, { erro: 'Não foi possível consultar o CPF agora. Tente novamente.', permiteManual: process.env.ALLOW_MANUAL_NAME === 'true' });
    }
  }

  if (rota === 'POST /api/checkin') {
    const corpo = await lerCorpo(req);
    const local = validarQr(corpo.l, corpo.k);
    if (!local) return json(res, 403, { erro: 'QR Code inválido.' });
    if (corpo.aceite !== true) return json(res, 400, { erro: 'É necessário aceitar o termo.' });

    const cpfs = [corpo.titular, ...(Array.isArray(corpo.participantes) ? corpo.participantes : [])].map(limparCpf);
    if (new Set(cpfs).size !== cpfs.length) return json(res, 400, { erro: 'Há CPFs repetidos na lista.' });
    if (cpfs.length > (local.capacidade || 20)) return json(res, 400, { erro: `Capacidade máxima do espaço: ${local.capacidade} pessoas.` });

    // Os nomes vêm do cache do servidor (consultados antes), nunca do navegador.
    const pessoas = [];
    for (const cpf of cpfs) {
      const r = cpfValido(cpf) && nomeEmCache(cpf);
      if (!r) return json(res, 400, { erro: 'Algum CPF não foi validado. Refaça a consulta.' });
      pessoas.push({ cpf, nome: r.nome, situacao: r.situacao, manual: !!r.manual });
    }

    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(corpo.selfie || '');
    if (!m) return json(res, 400, { erro: 'Selfie não recebida.' });
    const img = Buffer.from(m[2], 'base64');
    if (img.length < 2000) return json(res, 400, { erro: 'Selfie inválida.' });

    const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
    const arqSelfie = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(SELFIES, arqSelfie), img);

    const registro = {
      id,
      data: new Date().toISOString(),
      local: { id: local.id, nome: local.nome },
      titular: pessoas[0],
      participantes: pessoas.slice(1),
      aceiteTermo: { aceito: true, em: new Date().toISOString(), hashTermo: crypto.createHash('sha256').update(fs.readFileSync(TERMO_FILE)).digest('hex').slice(0, 16) },
      selfie: arqSelfie,
      ip: ipDe(req),
      userAgent: req.headers['user-agent'] || '',
    };
    const lista = lerJson(CHECKINS_FILE, []);
    lista.push(registro);
    gravarJson(CHECKINS_FILE, lista);
    console.log(`[checkin] ${id} ${local.nome} — ${pessoas.map((p) => p.nome).join(', ')}`);
    return json(res, 201, { id, local: local.nome, nomes: pessoas.map((p) => p.nome) });
  }

  // ------------------------------------------------------------ admin API
  if (url.pathname.startsWith('/api/admin/')) {
    if (!exigirAdmin(req, res)) return;

    if (rota === 'GET /api/admin/locais') {
      const base = (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/$/, '');
      return json(res, 200, locais().map((l) => ({ ...l, url: `${base}/?l=${encodeURIComponent(l.id)}&k=${assinar(l.id)}` })));
    }

    if (rota === 'POST /api/admin/locais') {
      const corpo = await lerCorpo(req, 10 * 1024);
      const nome = String(corpo.nome || '').trim();
      const capacidade = Math.max(1, Math.min(500, Number(corpo.capacidade) || 10));
      if (!nome) return json(res, 400, { erro: 'Informe o nome do espaço.' });
      const id = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const lista = locais();
      if (lista.some((l) => l.id === id)) return json(res, 409, { erro: 'Já existe um espaço com esse nome.' });
      lista.push({ id, nome, capacidade });
      gravarJson(LOCAIS_FILE, lista);
      return json(res, 201, { id });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/locais/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      gravarJson(LOCAIS_FILE, locais().filter((l) => l.id !== id));
      return json(res, 200, { ok: true });
    }

    if (rota === 'GET /api/admin/checkins') {
      return json(res, 200, lerJson(CHECKINS_FILE, []).slice().reverse());
    }
  }

  return json(res, 404, { erro: 'Rota não encontrada' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      if (!exigirAdmin(req, res)) return;
      return servirArquivo(res, path.join(PUBLIC, 'admin.html'), { 'Cache-Control': 'no-store' });
    }

    if (url.pathname.startsWith('/selfies/')) {
      if (!exigirAdmin(req, res)) return;
      const nome = path.basename(url.pathname);
      return servirArquivo(res, path.join(SELFIES, nome), { 'Cache-Control': 'private, max-age=3600' });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const arq = path.normalize(path.join(PUBLIC, rel));
    if (!arq.startsWith(PUBLIC) || rel === 'admin.html') { res.writeHead(404); return res.end(); }
    servirArquivo(res, arq);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno' });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`OKAY Check-in rodando em http://localhost:${PORT}`);
  console.log(`Painel admin:           http://localhost:${PORT}/admin  (usuário: ${ADMIN_USER})`);
  console.log(`Consulta de CPF:        ${process.env.CPF_PROVIDER || 'mock'}${process.env.CPF_PROVIDER === 'serpro' && process.env.SERPRO_TRIAL === 'true' ? ' (trial)' : ''}`);
});
