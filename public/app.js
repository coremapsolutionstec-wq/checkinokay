(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const QR = { l: params.get('l'), k: params.get('k') };

  const estado = {
    local: null,
    titular: null,          // { cpf, nome, telefone }
    participantes: [],      // [{ cpf, nome }]
    selfie: null,           // dataURL
    stream: null,
  };

  // ------------------------------------------------------------- utilitários
  function mostrar(id) {
    document.querySelectorAll('.tela').forEach((t) => t.classList.toggle('ativa', t.id === id));
    const passo = { 't-cpf': 1, 't-participantes': 2, 't-termo': 3, 't-selfie': 4 }[id];
    const barra = $('#passos');
    barra.hidden = !passo;
    barra.querySelectorAll('li').forEach((li) => {
      const n = Number(li.dataset.p);
      li.classList.toggle('feito', passo > n);
      li.classList.toggle('atual', passo === n);
    });
    if (id !== 't-selfie') pararCamera();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function mascaraCpf(v) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  function cpfValido(v) {
    const c = v.replace(/\D/g, '');
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    for (const t of [9, 10]) {
      let s = 0;
      for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
    }
    return true;
  }

  function iniciais(nome) {
    const p = nome.split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }

  function titulo(nome) {
    const minus = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
    return nome.toLowerCase().split(/\s+/).map((w, i) => (i > 0 && minus.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(caminho, corpo) {
    const r = await fetch(caminho, corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : {});
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || 'Erro inesperado. Tente novamente.'), { dados, status: r.status });
    return dados;
  }

  function carregando(btn, sim) {
    btn.disabled = sim;
    btn.classList.toggle('carregando', sim);
  }

  function mascaraTel(v) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  const limparNome = (v) => v.replace(/\s+/g, ' ').trim();
  const nomeValido = (n) => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.split(' ').filter((p) => p.length >= 2).length >= 2;
  const telefoneValido = (d) => /^[1-9]{2}9?\d{8}$/.test(d) && (d.length === 10 || d[2] === '9');
  const cpfMascarado = (c) => `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**`;

  document.querySelectorAll('input.cpf').forEach((inp) => {
    inp.addEventListener('input', () => { inp.value = mascaraCpf(inp.value); });
  });
  document.querySelectorAll('input.tel').forEach((inp) => {
    inp.addEventListener('input', () => { inp.value = mascaraTel(inp.value); });
  });
  document.querySelectorAll('[data-voltar]').forEach((b) => b.addEventListener('click', () => mostrar(b.dataset.voltar)));

  // Marca o campo com erro e mostra a mensagem
  function erroCampo(alvoErro, inp, msg) {
    $(alvoErro).textContent = msg;
    inp.setAttribute('aria-invalid', 'true');
    inp.focus();
    inp.addEventListener('input', () => inp.removeAttribute('aria-invalid'), { once: true });
  }

  // ------------------------------------------------------------------ início
  async function iniciar() {
    if (!QR.l || !QR.k) return mostrar('t-qr');
    try {
      estado.local = await api(`/api/local?l=${encodeURIComponent(QR.l)}&k=${encodeURIComponent(QR.k)}`);
      $('#nomeLocal').textContent = estado.local.nome;
      document.title = `Check-in · ${estado.local.nome}`;
      mostrar('t-inicio');
    } catch (e) {
      $('#msgQr').textContent = e.message;
      mostrar('t-qr');
    }
  }

  $('#btnIniciar').addEventListener('click', () => {
    mostrar('t-cpf');
    setTimeout(() => $('#cpfTitular').focus(), 250);
  });

  // ------------------------------------------------- passo 1: dados do titular
  $('#formTitular').addEventListener('submit', (ev) => {
    ev.preventDefault();
    $('#erroCpf').textContent = '';
    const cpfInp = $('#cpfTitular');
    const nomeInp = $('#nomeTitular');
    const telInp = $('#telTitular');
    const cpf = cpfInp.value.replace(/\D/g, '');
    const nome = limparNome(nomeInp.value);
    const telefone = telInp.value.replace(/\D/g, '');
    if (!cpfValido(cpf)) return erroCampo('#erroCpf', cpfInp, 'CPF inválido. Confira os números digitados.');
    if (!nomeValido(nome)) return erroCampo('#erroCpf', nomeInp, 'Informe seu nome completo (nome e sobrenome).');
    if (!telefoneValido(telefone)) return erroCampo('#erroCpf', telInp, 'Telefone inválido. Informe DDD + número.');
    nomeInp.value = nome;
    estado.titular = { cpf, nome, telefone };
    estado.participantes = estado.participantes.filter((p) => p.cpf !== cpf);
    renderPessoas();
    mostrar('t-participantes');
  });

  // ----------------------------------------------------- passo 2: participantes
  function renderPessoas() {
    const todos = [{ ...estado.titular, titular: true }, ...estado.participantes];
    $('#listaPessoas').innerHTML = todos.map((p, i) => `
      <li class="${p.titular ? 'titular' : ''}">
        <span class="avatar">${esc(iniciais(p.nome))}</span>
        <span class="pessoa-info"><strong>${esc(titulo(p.nome))}</strong><span>${p.titular ? 'Titular' : 'Participante'} · CPF ${esc(cpfMascarado(p.cpf))}</span></span>
        ${p.titular ? '' : `<button class="remover" data-i="${i - 1}" aria-label="Remover ${esc(titulo(p.nome))}">×</button>`}
      </li>`).join('');
    const cap = estado.local.capacidade;
    const cheio = todos.length >= cap;
    $('#capacidade').textContent = `${todos.length} de ${cap} pessoas (capacidade do espaço).`;
    $('#formPart').querySelectorAll('input, button').forEach((el) => { el.disabled = cheio; });
  }

  $('#listaPessoas').addEventListener('click', (ev) => {
    const b = ev.target.closest('.remover');
    if (!b) return;
    estado.participantes.splice(Number(b.dataset.i), 1);
    renderPessoas();
  });

  $('#formPart').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const cpfInp = $('#cpfPart');
    const nomeInp = $('#nomePart');
    $('#erroPart').textContent = '';
    const cpf = cpfInp.value.replace(/\D/g, '');
    const nome = limparNome(nomeInp.value);
    if (!cpfValido(cpf)) return erroCampo('#erroPart', cpfInp, 'CPF do participante inválido. Confira os números digitados.');
    if (cpf === estado.titular.cpf || estado.participantes.some((p) => p.cpf === cpf)) return erroCampo('#erroPart', cpfInp, 'Este CPF já está na lista.');
    if (!nomeValido(nome)) return erroCampo('#erroPart', nomeInp, 'Informe o nome completo do participante.');
    estado.participantes.push({ cpf, nome });
    cpfInp.value = '';
    nomeInp.value = '';
    renderPessoas();
    cpfInp.focus();
  });

  $('#btnParaTermo').addEventListener('click', async () => {
    if ($('#cpfPart').value.replace(/\D/g, '').length || $('#nomePart').value.trim()) {
      $('#erroPart').textContent = 'Toque em "Adicionar participante" para incluir os dados digitados, ou apague os campos.';
      return;
    }
    await carregarTermo();
    mostrar('t-termo');
  });

  // ---------------------------------------------------------- passo 3: termo
  let termoCarregado = false;
  async function carregarTermo() {
    if (termoCarregado) return;
    const md = await fetch('/api/termo').then((r) => r.text());
    $('#textoTermo').innerHTML = markdown(md);
    termoCarregado = true;
  }

  function markdown(md) {
    let html = '';
    let lista = false;
    for (const bruta of md.split(/\r?\n/)) {
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

  $('#aceite').addEventListener('change', (e) => { $('#btnConfirmar').disabled = !e.target.checked; });
  $('#btnConfirmar').addEventListener('click', () => {
    if (!$('#aceite').checked) return;
    $('#subSelfie').textContent = estado.participantes.length
      ? `Reúna todos os ${estado.participantes.length + 1} participantes na foto.`
      : 'Posicione seu rosto no centro da tela.';
    mostrar('t-selfie');
    resetSelfie();
    abrirCamera();
  });

  // --------------------------------------------------------- passo 4: selfie
  const video = $('#video');
  const foto = $('#foto');

  function pararCamera() {
    if (estado.stream) { estado.stream.getTracks().forEach((t) => t.stop()); estado.stream = null; }
  }

  function msgCamera(html) {
    const m = $('#cameraMsg');
    m.hidden = !html;
    m.innerHTML = html || '';
  }

  async function abrirCamera() {
    msgCamera('');
    if (!navigator.mediaDevices?.getUserMedia) {
      msgCamera('<div>Seu navegador não permite abrir a câmera aqui.<br><button class="btn" id="btnArquivo">Usar a câmera do celular</button></div>');
      return;
    }
    try {
      estado.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      video.srcObject = estado.stream;
      video.hidden = false;
      $('#btnCapturar').disabled = false;
    } catch (e) {
      const negado = e.name === 'NotAllowedError';
      msgCamera(`<div>${negado ? 'Permita o acesso à câmera nas configurações do navegador para tirar a selfie.' : 'Não foi possível abrir a câmera.'}<br>
        <button class="btn" id="btnTentarCam">Tentar de novo</button> <button class="btn" id="btnArquivo">Usar a câmera do celular</button></div>`);
    }
  }

  $('#cameraMsg').addEventListener('click', (ev) => {
    if (ev.target.id === 'btnTentarCam') abrirCamera();
    if (ev.target.id === 'btnArquivo') $('#arquivoSelfie').click();
  });

  function paraDataUrl(fonte, w, h) {
    const max = 1080;
    const escala = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * escala);
    c.height = Math.round(h * escala);
    c.getContext('2d').drawImage(fonte, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  function mostrarFoto(dataUrl) {
    estado.selfie = dataUrl;
    foto.src = dataUrl;
    foto.hidden = false;
    video.hidden = true;
    msgCamera('');
    pararCamera();
    $('#btnCapturar').hidden = true;
    $('#btnRefazer').hidden = false;
    $('#btnEnviar').hidden = false;
  }

  function resetSelfie() {
    estado.selfie = null;
    foto.hidden = true;
    video.hidden = false;
    $('#btnCapturar').hidden = false;
    $('#btnCapturar').disabled = true;
    $('#btnRefazer').hidden = true;
    $('#btnEnviar').hidden = true;
    $('#erroSelfie').textContent = '';
  }

  $('#btnCapturar').addEventListener('click', () => {
    if (!estado.stream || !video.videoWidth) { $('#arquivoSelfie').click(); return; }
    mostrarFoto(paraDataUrl(video, video.videoWidth, video.videoHeight));
  });

  $('#arquivoSelfie').addEventListener('change', (ev) => {
    const arq = ev.target.files?.[0];
    if (!arq) return;
    const img = new Image();
    img.onload = () => { mostrarFoto(paraDataUrl(img, img.naturalWidth, img.naturalHeight)); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(arq);
    ev.target.value = '';
  });

  $('#btnRefazer').addEventListener('click', () => { resetSelfie(); abrirCamera(); });

  $('#btnEnviar').addEventListener('click', async () => {
    const btn = $('#btnEnviar');
    $('#erroSelfie').textContent = '';
    carregando(btn, true);
    $('#btnRefazer').disabled = true;
    try {
      const r = await api('/api/checkin', {
        l: QR.l,
        k: QR.k,
        titular: estado.titular,
        participantes: estado.participantes,
        aceite: $('#aceite').checked,
        selfie: estado.selfie,
      });
      const primeiro = titulo(estado.titular.nome).split(' ')[0];
      $('.boas-vindas').textContent = `Seja bem-vindo ao OKAY, ${primeiro}!`;
      $('#subFim').textContent = r.nomes.length > 1
        ? `Check-in confirmado em ${r.local} para ${r.nomes.length} pessoas:`
        : `Seu check-in em ${r.local} está confirmado.`;
      $('#nomesFim').innerHTML = r.nomes.length > 1 ? r.nomes.map((n) => `<li>${esc(titulo(n))}</li>`).join('') : '';
      $('#codigoFim').textContent = `Código do check-in: ${r.id}`;
      estado.titular = null;
      estado.participantes = [];
      estado.selfie = null;
      history.replaceState(null, '', location.pathname + location.search);
      mostrar('t-fim');
    } catch (e) {
      $('#erroSelfie').textContent = e.message;
    } finally {
      carregando(btn, false);
      $('#btnRefazer').disabled = false;
    }
  });

  window.addEventListener('pagehide', pararCamera);
  iniciar();
})();
