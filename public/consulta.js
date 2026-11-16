// Consulta de check-ins: aceites do termo e selfies. Exige login de administrador.
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtCpf = (c) => String(c || '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  const fmtTel = (t) => !t ? '' : t.length === 11 ? t.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3') : t.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  const titulo = (n) => String(n || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\s(Da|De|Do|Das|Dos|E)\s/g, (m) => m.toLowerCase());

  // Datas sempre no horário de Brasília
  const TZ = 'America/Sao_Paulo';
  const chaveDia = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d)); // AAAA-MM-DD
  const fmtHora = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  const fmtDataHora = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(d));
  const fmtDiaLongo = (k) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(k + 'T12:00:00Z'));
  const hojeChave = () => chaveDia(Date.now());
  const diasAtras = (n) => chaveDia(Date.now() - n * 86400000);

  function dispositivo(ua) {
    if (!ua) return '—';
    const so = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Outro';
    const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'navegador';
    return `${so} · ${nav}`;
  }

  function markdown(md) {
    let html = '';
    let lista = false;
    for (const bruta of String(md).split(/\r?\n/)) {
      const linha = bruta.trim();
      const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (/^- /.test(linha)) {
        if (!lista) { html += '<ul>'; lista = true; }
        html += `<li>${inline(linha.slice(2))}</li>`;
        continue;
      }
      if (lista) { html += '</ul>'; lista = false; }
      if (!linha) continue;
      const h = linha.match(/^(#{1,3})\s+(.*)$/);
      html += h ? `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>` : `<p>${inline(linha)}</p>`;
    }
    return html + (lista ? '</ul>' : '');
  }

  // ------------------------------------------------------------- login
  let credencial = null;
  try { credencial = sessionStorage.getItem('okay-admin'); } catch { /* indisponível */ }
  let atualizador = 0;

  async function api(caminho) {
    const r = await fetch(location.origin + caminho, { headers: { Authorization: 'Basic ' + credencial } });
    if (r.status === 401) { mostrarLogin('Usuário ou senha incorretos.'); throw new Error('não autorizado'); }
    return r;
  }

  function mostrarLogin(erro = '') {
    clearInterval(atualizador);
    credencial = null;
    try { sessionStorage.removeItem('okay-admin'); } catch { /* ok */ }
    $('#painel').hidden = true;
    $('#btnSair').hidden = true;
    $('#login').hidden = false;
    $('#erroLogin').textContent = erro;
    $('#formLogin [name=senha]').value = '';
    $('#formLogin [name=senha]').focus();
  }

  $('#formLogin').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    credencial = btoa(String.fromCharCode(...new TextEncoder().encode(`${f.get('usuario')}:${f.get('senha')}`)));
    const btn = $('button', ev.target);
    btn.disabled = true;
    try {
      await abrirPainel();
      try { sessionStorage.setItem('okay-admin', credencial); } catch { /* ok */ }
    } catch { /* erro já exibido */ } finally { btn.disabled = false; }
  });
  $('#btnSair').addEventListener('click', () => mostrarLogin());

  // ------------------------------------------------------------- dados
  let checkins = [];
  let filtrados = [];
  let limite = 60;
  const filtro = { periodo: '30', de: '', ate: '', local: '', busca: '' };

  async function carregar() {
    checkins = await api('/api/admin/checkins').then((r) => r.json());
    const sel = $('#filtroLocal');
    const atual = sel.value;
    const locais = [...new Map(checkins.map((c) => [c.local.id, c.local.nome])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML = '<option value="">Todos os espaços</option>' + locais.map(([id, nome]) => `<option value="${esc(id)}">${esc(nome)}</option>`).join('');
    sel.value = locais.some(([id]) => id === atual) ? atual : '';
    aplicar();
  }

  async function abrirPainel() {
    await carregar();
    $('#login').hidden = true;
    $('#painel').hidden = false;
    $('#btnSair').hidden = false;
    clearInterval(atualizador);
    atualizador = setInterval(() => { if (!$('#ficha').open) carregar().catch(() => {}); }, 30000);
  }

  function dentroDoPeriodo(c) {
    const k = chaveDia(c.data);
    switch (filtro.periodo) {
      case 'hoje': return k === hojeChave();
      case '7': return k >= diasAtras(6);
      case '30': return k >= diasAtras(29);
      case 'datas': return (!filtro.de || k >= filtro.de) && (!filtro.ate || k <= filtro.ate);
      default: return true;
    }
  }

  function textoBusca(c) {
    const pessoas = [c.titular, ...(c.participantes || [])];
    return [c.id, c.local.nome, ...pessoas.flatMap((p) => [p.nome, p.cpf, fmtCpf(p.cpf), p.telefone || '', fmtTel(p.telefone)])].join(' ').toLowerCase();
  }

  function aplicar() {
    const q = filtro.busca.trim().toLowerCase();
    const qDigitos = q.replace(/\D/g, '');
    filtrados = checkins.filter((c) => dentroDoPeriodo(c)
      && (!filtro.local || c.local.id === filtro.local)
      && (!q || textoBusca(c).includes(q) || (qDigitos.length >= 3 && textoBusca(c).replace(/\D/g, ' ').includes(qDigitos))));
    $('#totCheckins').textContent = filtrados.length.toLocaleString('pt-BR');
    $('#totPessoas').textContent = filtrados.reduce((s, c) => s + 1 + (c.participantes || []).length, 0).toLocaleString('pt-BR');
    $('#totAceites').textContent = filtrados.filter((c) => c.aceiteTermo?.aceito).length.toLocaleString('pt-BR');
    renderLista();
  }

  // ----------------------------------------------------------- selfies
  const fotos = new Map(); // arquivo -> Promise<URL local>
  function urlFoto(arq) {
    if (!fotos.has(arq)) {
      fotos.set(arq, api('/selfies/' + encodeURIComponent(arq))
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : ''))
        .catch(() => { fotos.delete(arq); return ''; }));
    }
    return fotos.get(arq);
  }
  const observador = 'IntersectionObserver' in window ? new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      observador.unobserve(e.target);
      urlFoto(e.target.dataset.selfie).then((u) => { if (u) e.target.src = u; });
    }
  }, { rootMargin: '200px' }) : null;

  // ------------------------------------------------------------- lista
  function renderLista() {
    const el = $('#lista');
    if (!filtrados.length) {
      el.innerHTML = `<p class="vazio">${checkins.length ? 'Nenhum check-in encontrado com esses filtros.' : 'Nenhum check-in realizado ainda.'}</p>`;
      return;
    }
    let html = '';
    let diaAtual = '';
    const visiveis = filtrados.slice(0, limite);
    const porDia = filtrados.reduce((m, c) => { const k = chaveDia(c.data); m[k] = (m[k] || 0) + 1; return m; }, {});
    for (const c of visiveis) {
      const k = chaveDia(c.data);
      if (k !== diaAtual) {
        diaAtual = k;
        html += `<div class="dia"><span>${esc(fmtDiaLongo(k))}</span><span>${porDia[k]} check-in${porDia[k] > 1 ? 's' : ''}</span></div>`;
      }
      const n = (c.participantes || []).length;
      html += `<button class="linha" data-id="${esc(c.id)}">
        <img class="thumb" data-selfie="${esc(c.selfie)}" alt="">
        <span class="hora">${fmtHora(c.data)}</span>
        <span class="quem"><strong>${esc(titulo(c.titular.nome))}</strong><span>${n ? `+ ${n} participante${n > 1 ? 's' : ''}` : 'Sozinho'} · ${esc(c.local.nome)}</span></span>
        <span class="selos">${c.aceiteTermo?.aceito ? '<span class="selo ok">✓ Termo aceito</span>' : '<span class="selo">Sem aceite</span>'}</span>
      </button>`;
    }
    if (filtrados.length > limite) html += `<button class="btn secundario mais" id="btnMais">Mostrar mais (${filtrados.length - limite} restantes)</button>`;
    el.innerHTML = html;
    el.querySelectorAll('img[data-selfie]').forEach((img) => {
      if (observador) observador.observe(img);
      else urlFoto(img.dataset.selfie).then((u) => { if (u) img.src = u; });
    });
  }

  $('#lista').addEventListener('click', (ev) => {
    if (ev.target.closest('#btnMais')) { limite += 60; renderLista(); return; }
    const linha = ev.target.closest('.linha');
    if (linha) abrirFicha(linha.dataset.id);
  });

  // ------------------------------------------------------------- filtros
  document.querySelectorAll('[data-periodo]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-periodo]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    filtro.periodo = b.dataset.periodo;
    $('#datas').hidden = filtro.periodo !== 'datas';
    if (filtro.periodo === 'datas' && !$('#de').value) { $('#de').value = diasAtras(29); $('#ate').value = hojeChave(); filtro.de = $('#de').value; filtro.ate = $('#ate').value; }
    limite = 60;
    aplicar();
  }));
  $('#de').addEventListener('change', (e) => { filtro.de = e.target.value; aplicar(); });
  $('#ate').addEventListener('change', (e) => { filtro.ate = e.target.value; aplicar(); });
  $('#filtroLocal').addEventListener('change', (e) => { filtro.local = e.target.value; limite = 60; aplicar(); });
  let tBusca = 0;
  $('#busca').addEventListener('input', (e) => { clearTimeout(tBusca); tBusca = setTimeout(() => { filtro.busca = e.target.value; limite = 60; aplicar(); }, 150); });

  // ------------------------------------------------------------- ficha
  const termos = new Map(); // hash -> Promise<texto|null>
  function textoTermo(hash) {
    if (!termos.has(hash)) {
      termos.set(hash, api('/api/admin/termos/' + hash).then(async (r) => (r.ok ? r.text() : null)).catch(() => null));
    }
    return termos.get(hash);
  }

  function linhaPessoa(p, papel) {
    return `<li><strong>${esc(titulo(p.nome))}</strong> <span>· ${papel} · CPF ${esc(fmtCpf(p.cpf))}${p.telefone ? ` · ${esc(fmtTel(p.telefone))}` : ''}</span></li>`;
  }

  async function abrirFicha(id) {
    const c = checkins.find((x) => x.id === id);
    if (!c) return;
    const dlg = $('#ficha');
    const aceite = c.aceiteTermo || {};
    const nPessoas = 1 + (c.participantes || []).length;
    dlg.innerHTML = `
      <div class="ficha">
        <div class="ficha-foto">
          <img id="fotoGrande" alt="Selfie do check-in ${esc(c.id)}">
          <div class="acoes-foto"><a class="btn secundario" id="baixarFoto" download="checkin-${esc(c.id)}.jpg" href="#">Baixar foto</a></div>
        </div>
        <div class="ficha-dados">
          <div class="ficha-topo">
            <div>
              <h2 id="fichaTitulo">${esc(titulo(c.titular.nome))}</h2>
              <div class="dica" style="margin-top:2px">${esc(c.local.nome)} · ${esc(fmtDataHora(c.data))}</div>
            </div>
            <button class="fechar" data-fechar aria-label="Fechar">×</button>
          </div>

          <div class="secao">
            <h3>Titular</h3>
            <dl class="campos">
              <dt>Nome</dt><dd>${esc(c.titular.nome)}</dd>
              <dt>CPF</dt><dd>${esc(fmtCpf(c.titular.cpf))}</dd>
              <dt>Telefone</dt><dd>${c.titular.telefone ? `<a href="https://wa.me/55${esc(c.titular.telefone)}" target="_blank" rel="noopener">${esc(fmtTel(c.titular.telefone))}</a>` : '—'}</dd>
            </dl>
          </div>

          <div class="secao">
            <h3>Participantes (${nPessoas - 1})</h3>
            ${(c.participantes || []).length ? `<ul class="pessoas-lista">${c.participantes.map((p) => linhaPessoa(p, 'Participante')).join('')}</ul>` : '<p class="dica" style="margin:0">O titular entrou sozinho.</p>'}
          </div>

          <div class="secao">
            <h3>Aceite do termo</h3>
            ${aceite.aceito
              ? `<div class="aceite-ok"><b>✓</b><span>Aceito em <strong>${esc(fmtDataHora(aceite.em || c.data))}</strong> pelo titular, em seu nome e dos participantes.</span></div>`
              : '<p class="erro">Sem registro de aceite.</p>'}
            <dl class="campos" style="margin-top:10px">
              <dt>Versão do termo</dt><dd><code>${esc(aceite.hashTermo || '—')}</code></dd>
              <dt>Dispositivo</dt><dd>${esc(dispositivo(c.userAgent))}</dd>
              <dt>IP</dt><dd>${esc(c.ip || '—')}</dd>
              <dt>Código</dt><dd><code>${esc(c.id)}</code></dd>
            </dl>
            ${aceite.hashTermo ? '<button class="btn secundario" id="verTermo" style="margin-top:12px;min-height:40px;padding:8px 14px;font-size:14px">Ver texto aceito</button><div class="texto-termo" id="textoTermo" hidden></div>' : ''}
          </div>

          <div class="ficha-acoes">
            <button class="btn primario" id="imprimir">Imprimir comprovante</button>
            <button class="btn fantasma" data-fechar>Fechar</button>
          </div>
        </div>
      </div>`;
    dlg.showModal();
    $('.fechar', dlg).focus();

    const url = await urlFoto(c.selfie);
    if (url && dlg.open) {
      $('#fotoGrande').src = url;
      $('#baixarFoto').href = url;
    } else if (dlg.open) {
      $('#fotoGrande').alt = 'Foto indisponível';
      $('#baixarFoto').hidden = true;
    }

    $('#verTermo')?.addEventListener('click', async (ev) => {
      const box = $('#textoTermo');
      if (!box.hidden) { box.hidden = true; ev.target.textContent = 'Ver texto aceito'; return; }
      ev.target.textContent = 'Carregando…';
      const txt = await textoTermo(aceite.hashTermo);
      box.innerHTML = txt ? markdown(txt) : '<p>O texto desta versão não foi arquivado (check-in feito antes do arquivamento dos termos).</p>';
      box.hidden = false;
      ev.target.textContent = 'Ocultar texto';
    });

    $('#imprimir').addEventListener('click', () => imprimir(c, url));
  }

  $('#ficha').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-fechar]') || ev.target === ev.currentTarget) $('#ficha').close();
  });

  async function imprimir(c, url) {
    const aceite = c.aceiteTermo || {};
    const txt = aceite.hashTermo ? await textoTermo(aceite.hashTermo) : null;
    const pessoas = [c.titular, ...(c.participantes || [])];
    $('#impressao').innerHTML = `
      ${url ? `<img src="${url}" alt="">` : ''}
      <h1>Comprovante de check-in — OKAY</h1>
      <div>${esc(c.local.nome)} · ${esc(fmtDataHora(c.data))} · código ${esc(c.id)}</div>
      <h2>Pessoas (${pessoas.length})</h2>
      ${pessoas.map((p, i) => `<div>${i === 0 ? '<b>Titular:</b>' : 'Participante:'} ${esc(p.nome)} — CPF ${esc(fmtCpf(p.cpf))}${p.telefone ? ` — tel. ${esc(fmtTel(p.telefone))}` : ''}</div>`).join('')}
      <h2>Aceite do termo</h2>
      <div>${aceite.aceito ? `Termo aceito em ${esc(fmtDataHora(aceite.em || c.data))} (horário de Brasília), versão ${esc(aceite.hashTermo || '—')}.` : 'Sem registro de aceite.'}</div>
      <div>Dispositivo: ${esc(dispositivo(c.userAgent))} · IP: ${esc(c.ip || '—')}</div>
      ${txt ? `<h2>Texto aceito</h2><div class="termo-impresso">${markdown(txt)}</div>` : ''}
      <p style="margin-top:18px;font-size:9pt;color:#555">Emitido em ${esc(fmtDataHora(Date.now()))} pelo painel de consulta OKAY.</p>`;
    const img = $('#impressao img');
    if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    window.print();
  }

  // ------------------------------------------------------------- planilha
  $('#btnCsv').addEventListener('click', () => {
    const cel = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cab = ['Código', 'Data', 'Hora', 'Espaço', 'Titular', 'CPF titular', 'Telefone titular', 'Participantes', 'Total de pessoas', 'Termo aceito em', 'Versão do termo', 'Dispositivo', 'IP'];
    const linhas = filtrados.map((c) => {
      const d = new Date(c.data);
      return [
        c.id,
        new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short' }).format(d),
        new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, timeStyle: 'medium' }).format(d),
        c.local.nome, c.titular.nome, fmtCpf(c.titular.cpf), fmtTel(c.titular.telefone),
        (c.participantes || []).map((p) => `${p.nome} (${fmtCpf(p.cpf)})`).join('; '),
        1 + (c.participantes || []).length,
        c.aceiteTermo?.aceito ? fmtDataHora(c.aceiteTermo.em || c.data) : 'não',
        c.aceiteTermo?.hashTermo || '', dispositivo(c.userAgent), c.ip || '',
      ].map(cel).join(';');
    });
    const csv = '﻿' + [cab.map(cel).join(';'), ...linhas].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `checkins-okay-${hojeChave()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ------------------------------------------------------------- início
  if (credencial) abrirPainel().catch(() => {});
  else mostrarLogin();
})();
