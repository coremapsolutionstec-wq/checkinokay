// OKAY Check-in no Netlify: as rotas /api/* e /selfies/* rodam aqui.
// O Netlify não tem disco persistente, então os dados ficam no Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { criarApp, CABECALHOS_SEGURANCA } from '../../lib/app.js';

const loja = () => getStore({ name: 'okay-checkin', consistency: 'strong' });

const storage = {
  async getText(key) { return loja().get(key, { type: 'text' }); },
  async setText(key, txt) { await loja().set(key, txt); },
  async getJSON(key) { return loja().get(key, { type: 'json' }); },
  async setJSON(key, v) { await loja().setJSON(key, v); },
  async getBinary(key) {
    const r = await loja().getWithMetadata(key, { type: 'arrayBuffer' });
    return r ? { data: new Uint8Array(r.data), contentType: r.metadata?.contentType } : null;
  },
  async setBinary(key, data, contentType) {
    await loja().set(key, new Blob([data]), { metadata: { contentType } });
  },
  // Um blob por check-in: escritas simultâneas não se sobrescrevem.
  async addCheckin(reg) { await loja().setJSON(`checkins/${reg.id}`, reg); },
  async listCheckins() {
    const { blobs } = await loja().list({ prefix: 'checkins/' });
    const chaves = blobs.map((b) => b.key).sort().reverse().slice(0, 500);
    const regs = await Promise.all(chaves.map((k) => loja().get(k, { type: 'json' })));
    return regs.filter(Boolean).sort((a, b) => (a.data < b.data ? 1 : -1));
  },
};

let app;

export default async (request, context) => {
  app ??= criarApp({ storage, env: process.env });
  const response = (await app.handle(request, { ip: context.ip, origem: new URL(request.url).origin }))
    || new Response('{"erro":"Rota não encontrada"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  for (const [k, v] of Object.entries(CABECALHOS_SEGURANCA)) response.headers.set(k, v);
  return response;
};

export const config = { path: ['/api/*', '/selfies/*'] };
