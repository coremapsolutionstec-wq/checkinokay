#!/usr/bin/env bash
# Instala ou atualiza o OKAY Check-in em um servidor Ubuntu/Debian com HTTPS (Caddy).
#
# Uso:  sudo bash install.sh checkin.seudominio.com.br
#
# Rodar de novo com o mesmo domínio atualiza o código (git pull) e reinicia,
# sem mexer no .env nem na pasta data/.
set -euo pipefail

DOMINIO="${1:-}"
REPO="https://github.com/coremapsolutionstec-wq/checkinokay.git"
DIR="/opt/checkinokay"
USUARIO="checkinokay"

if [[ $EUID -ne 0 ]]; then echo "Rode com sudo: sudo bash $0 seu.dominio.com.br"; exit 1; fi
if [[ -z "$DOMINIO" || "$DOMINIO" == *"/"* || "$DOMINIO" == *" "* ]]; then
  echo "Informe o domínio, sem https:// — ex.: sudo bash $0 checkin.okay.com.br"; exit 1
fi

passo() { echo; echo "==> $*"; }

passo "Pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ufw ca-certificates gnupg >/dev/null

passo "Node.js"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

passo "Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
echo "$(caddy version)"

passo "Usuário de serviço"
id -u "$USUARIO" >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin "$USUARIO"

passo "Código"
if [[ -d "$DIR/.git" ]]; then
  sudo -u "$USUARIO" git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
mkdir -p "$DIR/data/selfies"

NOVA_SENHA=""
if [[ ! -f "$DIR/.env" ]]; then
  passo "Criando .env"
  NOVA_SENHA="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
  cp "$DIR/.env.example" "$DIR/.env"
  sed -i \
    -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMINIO|" \
    -e "s|^HOST=.*|HOST=127.0.0.1|" \
    -e "s|^TRUST_PROXY=.*|TRUST_PROXY=true|" \
    -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$NOVA_SENHA|" \
    "$DIR/.env"
fi
chown -R "$USUARIO:$USUARIO" "$DIR"
chmod 600 "$DIR/.env"

passo "Serviço systemd"
cp "$DIR/deploy/checkinokay.service" /etc/systemd/system/checkinokay.service
systemctl daemon-reload
systemctl enable checkinokay >/dev/null 2>&1
systemctl restart checkinokay

passo "Caddyfile"
NOVO_CADDY="$(sed "s|SEU_DOMINIO|$DOMINIO|" "$DIR/deploy/Caddyfile")"
if [[ -f /etc/caddy/Caddyfile ]] && [[ "$(cat /etc/caddy/Caddyfile)" != "$NOVO_CADDY" ]]; then
  BACKUP="/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  cp /etc/caddy/Caddyfile "$BACKUP"
  echo "Caddyfile anterior salvo em $BACKUP"
fi
printf '%s\n' "$NOVO_CADDY" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

passo "Firewall (SSH, 80, 443)"
# Libera a porta SSH em uso nesta conexão para não trancar você fora do servidor.
PORTA_SSH="$(echo "${SSH_CONNECTION:-}" | awk '{print $4}')"
ufw allow "${PORTA_SSH:-22}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,10p'

sleep 2
passo "Pronto!"
if systemctl is-active --quiet checkinokay; then echo "Serviço checkinokay: rodando"; else echo "ATENÇÃO: serviço não subiu. Veja: journalctl -u checkinokay -n 50"; fi
echo
echo "  Check-in:  https://$DOMINIO  (o certificado pode levar 1 minuto na primeira vez)"
echo "  Admin:     https://$DOMINIO/admin   usuário: admin"
if [[ -n "$NOVA_SENHA" ]]; then
  echo "  Senha admin gerada: $NOVA_SENHA   (anote; fica em $DIR/.env)"
fi
echo
echo "Próximos passos:"
echo "  1. Coloque as chaves do SERPRO em $DIR/.env (SERPRO_TRIAL=false) e rode: sudo systemctl restart checkinokay"
echo "  2. Imprima os QR Codes pelo /admin"
echo "  3. Logs: journalctl -u checkinokay -f"
