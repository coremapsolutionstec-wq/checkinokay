# OKAY — Check-in

Check-in para espaços privados (salas de reunião, coworking).

**Fluxo:** QR Code na entrada → CPF, nome e telefone do titular → participantes (CPF e nome) → termo com aceite → selfie → "Seja bem-vindo ao OKAY!"

## Rodar

Requer Node.js 20+. O servidor Node não precisa de `npm install` (a única dependência, `@netlify/blobs`, é usada só no Netlify).

```bash
cp .env.example .env     # ajuste ADMIN_PASSWORD
npm start
```

- Painel admin (QR Codes, espaços e check-ins): `http://localhost:3000/admin`
- Cada espaço tem um QR Code assinado (`/?l=<espaço>&k=<assinatura>`). Sem um QR válido, o check-in não abre.

## Dados digitados

O titular digita **CPF, nome completo e telefone**; cada participante, **CPF e nome**. Não há consulta a base externa: o sistema confere os dígitos verificadores do CPF, se o nome tem nome e sobrenome e se o telefone tem DDD + 8 ou 9 dígitos (celular começando com 9). As mesmas regras valem no navegador e no servidor ([lib/validacao.js](lib/validacao.js)). No painel admin, o telefone abre conversa no WhatsApp.

## Publicar com HTTPS

Os celulares só liberam a câmera para a selfie em **HTTPS**. O sistema grava os dados em disco (`data/`), então precisa de um servidor com disco que não se apague, como um VPS.

### Netlify (publicado em https://checkinokay.netlify.app)

No Netlify não existe disco, então as páginas ficam em `public/`, a API roda como função ([netlify/functions/api.mjs](netlify/functions/api.mjs)) e check-ins, selfies e espaços ficam no **Netlify Blobs** (loja `okay-checkin`). O HTTPS é automático.

- **Variáveis** (Project configuration → Environment variables): `ADMIN_PASSWORD` e `QR_SECRET`. Depois de mudar uma variável, publique de novo.
- **Publicar** uma nova versão (com a pasta vinculada via `netlify link`):

```bash
npm install
npx netlify-cli deploy --prod
```

- **Não troque o `QR_SECRET`**: se ele mudar, todos os QR Codes impressos param de funcionar.

### VPS Ubuntu + Caddy

1. No painel do domínio, crie um registro **A**: `checkin` → IP do VPS.
2. No VPS, por SSH:

```bash
curl -fsSL https://raw.githubusercontent.com/coremapsolutionstec-wq/checkinokay/main/deploy/install.sh -o install.sh
sudo bash install.sh checkin.seudominio.com.br
```

O script instala Node.js e Caddy (HTTPS automático com Let's Encrypt), cria um usuário só para o sistema, gera o `.env` com uma senha de admin aleatória, registra o serviço (que sobe sozinho ao reiniciar o servidor) e libera no firewall só SSH, 80 e 443. No final ele mostra a senha do admin.

3. Abra `https://checkin.seudominio.com.br/admin` e imprima os QR Codes.

**Atualizar** depois de novos commits: rode `sudo bash install.sh checkin.seudominio.com.br` de novo. Ele baixa o código novo e reinicia, sem mexer no `.env` nem nos dados.

**Logs:** `journalctl -u checkinokay -f`. **Backup:** copie periodicamente `/opt/checkinokay/data` e `/opt/checkinokay/.env`.

Arquivos usados: [deploy/install.sh](deploy/install.sh), [deploy/checkinokay.service](deploy/checkinokay.service), [deploy/Caddyfile](deploy/Caddyfile).

### Alternativa: Cloudflare Tunnel

Para rodar em um computador do próprio OKAY, sempre ligado, sem abrir portas no roteador: com o domínio no Cloudflare, instale o `cloudflared`, crie um túnel apontando para `http://localhost:3000` e use `HOST=127.0.0.1`, `TRUST_PROXY=true` e `PUBLIC_URL=https://seu-dominio` no `.env`. Se o computador desligar, o check-in para.

Se o navegador bloquear a câmera, o sistema oferece abrir a câmera nativa do celular.

## Dados

Tudo fica em `data/` (fora do git):

- `locais.json`: espaços e capacidade
- `checkins.json`: registros (titular com telefone, participantes, aceite do termo com hash do texto, data, IP)
- `selfies/`: fotos (acessíveis só pelo admin)
- `termo.md`: texto do termo (edite à vontade; o padrão está em `lib/termo-padrao.js`)
- `secret.txt`: segredo dos QR Codes (se for trocado, todos os QR Codes precisam ser reimpressos)

Dados pessoais (CPF, telefone e selfie) estão sujeitos à LGPD: defina um prazo de retenção e um canal para pedidos dos titulares.
