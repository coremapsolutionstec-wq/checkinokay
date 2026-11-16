// Validação dos dados digitados no check-in (sem consulta externa).

export function limparCpf(v) {
  return String(v || '').replace(/\D/g, '');
}

// Confere os dígitos verificadores do CPF.
export function cpfValido(v) {
  const c = limparCpf(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

export function limparNome(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Nome e sobrenome, só letras (com acento), espaço, apóstrofo e hífen.
export function nomeValido(nome) {
  return /^[\p{L}][\p{L}' -]*$/u.test(nome) && nome.split(' ').filter((p) => p.length >= 2).length >= 2;
}

// Telefone brasileiro: DDD + 8 ou 9 dígitos. Aceita +55 na frente.
export function limparTelefone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d;
}

export function telefoneValido(d) {
  return /^[1-9]{2}9?\d{8}$/.test(d) && (d.length === 10 || d[2] === '9');
}
