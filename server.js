// OKAY Check-in — servidor Node (local ou VPS), sem dependências externas.
// A lógica fica em lib/app.js; aqui só tem HTTP, arquivos estáticos e armazenamento em disco.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { criarApp, CABECALHOS_SEGURANCA } from './lib/app.js';
import { TERMO_PADRAO } from './lib/termo-padrao.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

// ------------------------------------------------------------------ .env
(function carregarEnv() {
  const arq = path.join(ROOT, '.env');
  if (!fs.existsSync(arq)) return;
  for (const linha of fs.readFileSync(arq, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = crypto.randomBytes(6).toString('base64url');
  console.log(`[admin] ADMIN_PASSWORD não definida. Senha temporária desta execução: ${process.env.ADMIN_PASSWORD}`);
}

// ------------------------------------------------- armazenamento em disco
fs.mkdirSync(path.join(DATA, 'selfies'), { recursive: true });
if (!fs.existsSync(path.join(DATA, 'termo.md'))) fs.writeFileSync(path.join(DATA, 'termo.md'), TERMO_PADRAO);

const arquivo = (key) => {
  const p = path.normalize(path.join(DATA, key));
  if (!p.startsWith(DATA + path.sep)) throw new Error('Chave inválida');
  return p;
};
function gravar(key, dados) {
  const p = arquivo(key);
  fs.writeFileSync(p + '.tmp', dados);
  fs.renameSync(p + '.tmp', p);
}
const CHECKINS = 'checkins.json';

const storage = {
  async getText(key) { try { return fs.readFileSync(arquivo(key), 'utf8'); } catch { return null; } },
  async setText(key, txt) { gravar(key, txt); },
  async getJSON(key) { try { return JSON.parse(fs.readFileSync(arquivo(key), 'utf8')); } catch { return null; } },
  async setJSON(key, v) { gravar(key, JSON.stringify(v, null, 2)); },
  async getBinary(key) {
    try {
      const ext = path.extname(key).toLowerCase();
      return { data: fs.readFileSync(arquivo(key)), contentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
    } catch { return null; }
  },
  async setBinary(key, data) { gravar(key, data); },
  async addCheckin(reg) {
    const lista = (await storage.getJSON(CHECKINS)) || [];
    lista.push(reg);
    await storage.setJSON(CHECKINS, lista);
  },
  async listCheckins() { return ((await storage.getJSON(CHECKINS)) || []).slice().reverse(); },
};

const app = criarApp({ storage });

// ---------------------------------------------------------------- HTTP
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
function ipDe(req) {
  // Só confia no X-Forwarded-For atrás de um proxy (Caddy, Cloudflare Tunnel).
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress;
}

function lerCorpoBruto(req, limite = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > limite) { reject(Object.assign(new Error('Requisição muito grande'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function servirArquivo(res, arq, extra = {}) {
  fs.stat(arq, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq).toLowerCase()] || 'application/octet-stream', ...extra });
    fs.createReadStream(arq).pipe(res);
  });
}

async function enviar(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CABECALHOS_SEGURANCA)) res.setHeader(k, v);
  try {
    const proto = (TRUST_PROXY && req.headers['x-forwarded-proto']) || 'http';
    const origem = `${proto}://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url, origem);

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/selfies/')) {
      const corpo = ['GET', 'HEAD'].includes(req.method) ? undefined : await lerCorpoBruto(req);
      const headers = {};
      for (const h of ['authorization', 'content-type', 'user-agent']) if (req.headers[h]) headers[h] = req.headers[h];
      const request = new Request(url, { method: req.method, headers, body: corpo });
      const response = await app.handle(request, { ip: ipDe(req), origem });
      if (response) return enviar(res, response);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"erro":"Rota não encontrada"}');
    }

    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin.html') {
      return servirArquivo(res, path.join(PUBLIC, 'admin.html'), { 'Cache-Control': 'no-store' });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const arq = path.normalize(path.join(PUBLIC, rel));
    if (!arq.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
    servirArquivo(res, arq);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ erro: e.status ? e.message : 'Erro interno' })); }
  }
});

const PORT = Number(process.env.PORT) || 3000;
// Em produção use HOST=127.0.0.1: só o proxy local (Caddy/cloudflared) alcança o Node.
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`OKAY Check-in rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (todas as interfaces)' : ''}`);
  console.log(`Painel admin:           http://localhost:${PORT}/admin  (usuário: ${process.env.ADMIN_USER || 'admin'})`);
});
