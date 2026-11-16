(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const QR = { l: params.get('l'), k: params.get('k') };

  const estado = {
    local: null,
    titular: null,          // { cpf, cpfMascarado, nome, situacao, token }
    participantes: [],
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
    if (id !== 't-qr') pararLeitor();
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

  document.querySelectorAll('input.cpf').forEach((inp) => {
    inp.addEventListener('input', () => { inp.value = mascaraCpf(inp.value); });
  });
  document.querySelectorAll('[data-voltar]').forEach((b) => b.addEventListener('click', () => mostrar(b.dataset.voltar)));

  async function consultar(cpf) {
    try {
      return await api('/api/cpf', { cpf, l: QR.l, k: QR.k });
    } catch (e) {
      if (e.dados?.permiteManual) {
        const nome = prompt(`${e.message}\n\nDigite o nome completo para o CPF ${mascaraCpf(cpf)}:`);
        if (nome && nome.trim()) return api('/api/cpf', { cpf, l: QR.l, k: QR.k, nomeManual: nome });
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ início
  // Com ?l=&k= na URL (QR lido pela câmera nativa do celular), vai para a tela de boas-vindas.
  // Sem eles, a primeira tela é o leitor de QR Code.
  let viaLeitor = false;

  async function carregarLocal(l, k) {
    const local = await api(`/api/local?l=${encodeURIComponent(l)}&k=${encodeURIComponent(k)}`);
    QR.l = l;
    QR.k = k;
    estado.local = local;
    $('#nomeLocal').textContent = local.nome;
    document.title = `Check-in · ${local.nome}`;
    return local;
  }

  async function iniciar() {
    if (!QR.l || !QR.k) return abrirLeitor();
    try {
      await carregarLocal(QR.l, QR.k);
      mostrar('t-inicio');
    } catch (e) {
      history.replaceState(null, '', location.pathname);
      abrirLeitor(e.message);
    }
  }

  // ------------------------------------------------------------ leitor de QR
  const leitor = { stream: null, ativo: false, timer: 0, detector: null, ultimo: '', ultimoEm: 0, ocupado: false };
  const videoQr = $('#videoQr');

  function msgLeitor(html) {
    const m = $('#leitorMsg');
    m.hidden = !html;
    m.innerHTML = html || '';
  }

  function pararLeitor() {
    leitor.ativo = false;
    clearTimeout(leitor.timer);
    if (leitor.stream) { leitor.stream.getTracks().forEach((t) => t.stop()); leitor.stream = null; }
  }

  function carregarJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsQR.js';
      s.onload = ok;
      s.onerror = falha;
      document.head.appendChild(s);
    });
  }

  async function abrirLeitor(erro = '') {
    mostrar('t-qr');
    $('#nomeLocal').textContent = '';
    $('#erroQr').textContent = erro;
    $('.camera.leitor').classList.remove('lido');
    msgLeitor('');
    if (!navigator.mediaDevices?.getUserMedia) {
      msgLeitor('<div>Este navegador não consegue abrir a câmera aqui.<br>Use a câmera do celular para ler o QR Code.</div>');
      return;
    }
    try {
      // Detector nativo (Android/Chrome) quando existir; senão, jsQR.
      if (!leitor.detector && 'BarcodeDetector' in window) {
        const formatos = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
        if (formatos.includes('qr_code')) leitor.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
      if (!leitor.detector) await carregarJsQR();
      pararLeitor();
      leitor.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      const negado = e && e.name === 'NotAllowedError';
      msgLeitor(`<div>${negado ? 'Permita o acesso à câmera para ler o QR Code.' : 'Não foi possível abrir a câmera.'}<br><button class="btn" id="btnTentarLeitor">Tentar de novo</button></div>`);
      return;
    }
    videoQr.srcObject = leitor.stream;
    videoQr.play().catch(() => {});
    leitor.ativo = true;
    escanear();
  }

  $('#leitorMsg').addEventListener('click', (ev) => {
    if (ev.target.id === 'btnTentarLeitor') abrirLeitor();
  });

  const canvasQr = document.createElement('canvas');
  const ctxQr = canvasQr.getContext('2d', { willReadFrequently: true });

  async function escanear() {
    if (!leitor.ativo) return;
    if (!leitor.ocupado && videoQr.readyState >= 2 && videoQr.videoWidth) {
      let texto = null;
      try {
        if (leitor.detector) {
          texto = (await leitor.detector.detect(videoQr))[0]?.rawValue || null;
        } else if (window.jsQR) {
          const w = Math.min(640, videoQr.videoWidth);
          const h = Math.round((videoQr.videoHeight * w) / videoQr.videoWidth);
          canvasQr.width = w;
          canvasQr.height = h;
          ctxQr.drawImage(videoQr, 0, 0, w, h);
          texto = window.jsQR(ctxQr.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data || null;
        }
      } catch { /* quadro ilegível: tenta o próximo */ }
      if (texto) await tratarQr(texto);
    }
    if (leitor.ativo) leitor.timer = setTimeout(escanear, 120);
  }

  async function tratarQr(texto) {
    // Não revalida o mesmo QR inválido sem parar (a câmera lê várias vezes por segundo).
    if (texto === leitor.ultimo && Date.now() - leitor.ultimoEm < 4000) return;
    leitor.ultimo = texto;
    leitor.ultimoEm = Date.now();

    let u;
    try { u = new URL(texto, location.href); } catch { u = null; }
    const l = u?.searchParams.get('l');
    const k = u?.searchParams.get('k');
    if (!l || !k) { $('#erroQr').textContent = 'Este QR Code não é de um espaço OKAY.'; return; }

    leitor.ocupado = true;
    try {
      await carregarLocal(l, k);
    } catch (e) {
      $('#erroQr').textContent = e.message;
      leitor.ocupado = false;
      return;
    }
    leitor.ocupado = false;
    $('#erroQr').textContent = '';
    $('.camera.leitor').classList.add('lido');
    navigator.vibrate?.(60);
    pararLeitor();
    viaLeitor = true;
    history.replaceState(null, '', `${location.pathname}?l=${encodeURIComponent(l)}&k=${encodeURIComponent(k)}`);
    setTimeout(() => {
      mostrar('t-cpf');
      setTimeout(() => $('#cpfTitular').focus(), 250);
    }, 350);
  }

  // Volta ao leitor para o próximo cliente (uso em tablet na entrada).
  let contagemTimer = 0;
  function novoCheckin() {
    clearInterval(contagemTimer);
    estado.titular = null;
    estado.participantes = [];
    estado.selfie = null;
    estado.local = null;
    QR.l = null;
    QR.k = null;
    for (const id of ['#cpfTitular', '#cpfPart']) $(id).value = '';
    for (const id of ['#erroCpf', '#erroPart', '#erroSelfie']) $(id).textContent = '';
    $('#cartaoTitular').hidden = true;
    $('#aceite').checked = false;
    $('#btnConfirmar').disabled = true;
    $('#novoCheckin').hidden = true;
    document.title = 'Check-in OKAY';
    history.replaceState(null, '', location.pathname);
    leitor.ultimo = '';
    abrirLeitor();
  }
  $('#btnNovo').addEventListener('click', novoCheckin);

  function agendarNovoCheckin(segundos = 20) {
    $('#novoCheckin').hidden = false;
    let resta = segundos;
    const atualizar = () => { $('#contagem').textContent = `Voltando ao leitor em ${resta}s…`; };
    atualizar();
    clearInterval(contagemTimer);
    contagemTimer = setInterval(() => {
      resta -= 1;
      if (resta <= 0) novoCheckin();
      else atualizar();
    }, 1000);
  }

  $('#btnIniciar').addEventListener('click', () => {
    mostrar('t-cpf');
    setTimeout(() => $('#cpfTitular').focus(), 250);
  });

  // ------------------------------------------------------------ passo 1: CPF
  $('#formCpf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inp = $('#cpfTitular');
    const btn = ev.submitter || $('#formCpf button');
    $('#erroCpf').textContent = '';
    $('#cartaoTitular').hidden = true;
    if (!cpfValido(inp.value)) { $('#erroCpf').textContent = 'CPF inválido. Confira os números digitados.'; inp.focus(); return; }
    carregando(btn, true);
    try {
      const p = await consultar(inp.value);
      estado.titular = p;
      $('#nomeTitular').textContent = p.nome;
      $('#detTitular').textContent = `CPF ${p.cpfMascarado}${p.situacao ? ' · ' + p.situacao : ''}`;
      $('#cartaoTitular').hidden = false;
      $('#btnSouEu').focus();
    } catch (e) {
      $('#erroCpf').textContent = e.message;
    } finally {
      carregando(btn, false);
    }
  });

  $('#btnNaoSou').addEventListener('click', () => {
    estado.titular = null;
    $('#cartaoTitular').hidden = true;
    const inp = $('#cpfTitular');
    inp.value = '';
    inp.focus();
  });

  $('#btnSouEu').addEventListener('click', () => {
    estado.participantes = estado.participantes.filter((p) => p.cpf !== estado.titular.cpf);
    renderPessoas();
    mostrar('t-participantes');
  });

  // ----------------------------------------------------- passo 2: participantes
  function renderPessoas() {
    const todos = [{ ...estado.titular, titular: true }, ...estado.participantes];
    $('#listaPessoas').innerHTML = todos.map((p, i) => `
      <li class="${p.titular ? 'titular' : ''}">
        <span class="avatar">${esc(iniciais(p.nome))}</span>
        <span class="pessoa-info"><strong>${esc(titulo(p.nome))}</strong><span>${p.titular ? 'Titular' : 'Participante'} · CPF ${esc(p.cpfMascarado)}</span></span>
        ${p.titular ? '' : `<button class="remover" data-i="${i - 1}" aria-label="Remover ${esc(titulo(p.nome))}">×</button>`}
      </li>`).join('');
    const cap = estado.local.capacidade;
    const cheio = todos.length >= cap;
    $('#capacidade').textContent = `${todos.length} de ${cap} pessoas (capacidade do espaço).`;
    $('#cpfPart').disabled = cheio;
    $('#formPart button').disabled = cheio;
  }

  $('#listaPessoas').addEventListener('click', (ev) => {
    const b = ev.target.closest('.remover');
    if (!b) return;
    estado.participantes.splice(Number(b.dataset.i), 1);
    renderPessoas();
  });

  $('#formPart').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inp = $('#cpfPart');
    const btn = $('#formPart button');
    const erro = $('#erroPart');
    erro.textContent = '';
    const cpf = inp.value.replace(/\D/g, '');
    if (!cpfValido(cpf)) { erro.textContent = 'CPF inválido. Confira os números digitados.'; inp.focus(); return; }
    if (cpf === estado.titular.cpf || estado.participantes.some((p) => p.cpf === cpf)) { erro.textContent = 'Este CPF já está na lista.'; inp.value = ''; return; }
    carregando(btn, true);
    try {
      const p = await consultar(cpf);
      estado.participantes.push(p);
      inp.value = '';
      renderPessoas();
      inp.focus();
    } catch (e) {
      erro.textContent = e.message;
    } finally {
      carregando(btn, false);
      renderPessoas();
    }
  });

  $('#btnParaTermo').addEventListener('click', async () => {
    if ($('#cpfPart').value.replace(/\D/g, '').length) {
      $('#erroPart').textContent = 'Toque em "Adicionar" para incluir o CPF digitado, ou apague o campo.';
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
        // Comprovantes assinados pelo servidor na consulta de cada CPF (titular primeiro)
        pessoas: [estado.titular, ...estado.participantes].map((p) => p.token),
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
      mostrar('t-fim');
      if (viaLeitor) agendarNovoCheckin();
    } catch (e) {
      $('#erroSelfie').textContent = e.message;
    } finally {
      carregando(btn, false);
      $('#btnRefazer').disabled = false;
    }
  });

  window.addEventListener('pagehide', () => { pararCamera(); pararLeitor(); });
  iniciar();
})();
