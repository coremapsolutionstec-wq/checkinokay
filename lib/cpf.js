// Validação de CPF e provedores de consulta de nome.

export function limparCpf(v) {
  return String(v || '').replace(/\D/g, '');
}

export function cpfValido(v) {
  const c = limparCpf(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    const dig = ((soma * 10) % 11) % 10;
    if (dig !== Number(c[t])) return false;
  }
  return true;
}

export function mascararCpf(v) {
  const c = limparCpf(v);
  return `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**`;
}

// ---------------------------------------------------------------- mock
const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Marcelo', 'Natália', 'Otávio', 'Paula', 'Rafael'];
const MEIOS = ['Cristina', 'Augusto', 'Beatriz', 'Eduardo', 'Helena', 'Luiz', 'Maria', 'Pedro'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Carvalho', 'Ferreira', 'Rodrigues', 'Almeida', 'Costa', 'Gomes'];

async function consultaMock(cpf) {
  await new Promise((r) => setTimeout(r, 500));
  const d = cpf.split('').map(Number);
  const s1 = (d[4] * 7 + d[5]) % SOBRENOMES.length;
  const s2 = (s1 + 1 + ((d[6] + d[7] * 5) % (SOBRENOMES.length - 1))) % SOBRENOMES.length;
  const nome = `${NOMES[(d[0] * 3 + d[1]) % NOMES.length]} ${MEIOS[(d[2] + d[3]) % MEIOS.length]} ${SOBRENOMES[s1]} ${SOBRENOMES[s2]}`;
  return { nome: nome.toUpperCase(), situacao: 'Regular (fictício)' };
}

// -------------------------------------------------------------- SERPRO
// Documentação: https://apicenter.estaleiro.serpro.gov.br/documentacao/consulta-cpf/
const SERPRO_TRIAL_TOKEN = '06aef429-a981-3ec5-a1f8-71d38d86481e';
let serproToken = null;

async function tokenSerpro() {
  if (process.env.SERPRO_TRIAL === 'true') return SERPRO_TRIAL_TOKEN;
  if (serproToken && serproToken.expira > Date.now()) return serproToken.valor;
  const key = process.env.SERPRO_CONSUMER_KEY;
  const secret = process.env.SERPRO_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('SERPRO_CONSUMER_KEY/SECRET não configurados');
  const r = await fetch('https://gateway.apiserpro.serpro.gov.br/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`SERPRO token HTTP ${r.status}`);
  const j = await r.json();
  serproToken = { valor: j.access_token, expira: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  return serproToken.valor;
}

async function consultaSerpro(cpf) {
  const trial = process.env.SERPRO_TRIAL === 'true';
  const base = trial
    ? 'https://gateway.apiserpro.serpro.gov.br/consulta-cpf-df-trial/v1/cpf/'
    : 'https://gateway.apiserpro.serpro.gov.br/consulta-cpf-df/v1/cpf/';
  const r = await fetch(base + cpf, {
    headers: { Authorization: 'Bearer ' + (await tokenSerpro()), Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 404) return null;
  if (r.status === 401) serproToken = null; // força renovar o token na próxima consulta
  if (!r.ok) throw new Error(`SERPRO HTTP ${r.status}${r.status === 429 ? ' (limite de consultas excedido)' : ''}`);
  const j = await r.json();
  // Códigos SERPRO: 0 Regular, 2 Suspensa, 3 Titular Falecido, 4 Pendente de
  // Regularização, 5 Cancelada por Multiplicidade, 8 Nula, 9 Cancelada de Ofício.
  const codigo = String(j.situacao?.codigo ?? '');
  const descricao = j.situacao?.descricao || '';
  const bloqueado = ['3', '5', '8', '9'].includes(codigo) || /falecid|nula|cancelad/i.test(descricao);
  return { nome: j.nome, situacao: descricao, bloqueado };
}

// -------------------------------------------------------------- custom
function pegarCaminho(obj, caminho) {
  return caminho.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function consultaCustom(cpf) {
  const url = (process.env.CPF_API_URL || '').replace('{cpf}', cpf);
  if (!url) throw new Error('CPF_API_URL não configurada');
  let headers = {};
  try { headers = JSON.parse(process.env.CPF_API_HEADERS || '{}'); } catch { /* ignora */ }
  const r = await fetch(url, {
    method: process.env.CPF_API_METHOD || 'GET',
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Provedor CPF HTTP ${r.status}`);
  const nome = pegarCaminho(await r.json(), process.env.CPF_API_NAME_PATH || 'nome');
  return nome ? { nome: String(nome), situacao: '' } : null;
}

// --------------------------------------------------------------- cache
// Evita pagar duas vezes pela mesma consulta em sequência (por instância).
const cache = new Map(); // cpf -> { nome, situacao, em }
const CACHE_MS = 30 * 60 * 1000;

export async function consultarCpf(cpf) {
  const c = cache.get(cpf);
  if (c && Date.now() - c.em < CACHE_MS) return c;
  const provedor = (process.env.CPF_PROVIDER || 'mock').toLowerCase();
  const fn = { mock: consultaMock, serpro: consultaSerpro, custom: consultaCustom }[provedor];
  if (!fn) throw new Error(`CPF_PROVIDER desconhecido: ${provedor}`);
  const res = await fn(cpf);
  if (res?.bloqueado) {
    throw Object.assign(new Error(`CPF com situação "${res.situacao}" na Receita Federal. Procure a recepção.`), { bloqueado: true });
  }
  if (res?.nome) {
    const item = { nome: res.nome.trim(), situacao: res.situacao || '', em: Date.now() };
    cache.set(cpf, item);
    return item;
  }
  return null;
}
