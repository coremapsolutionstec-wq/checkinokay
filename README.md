# OKAY — Check-in

Check-in para espaços privados (salas de reunião, coworking).

**Fluxo:** QR Code na entrada → CPF do titular (nome buscado na Receita) → participantes por CPF → termo com aceite → selfie → "Seja bem-vindo ao OKAY!"

## Rodar

Requer Node.js 20+ (sem dependências para instalar).

```bash
cp .env.example .env     # ajuste ADMIN_PASSWORD e CPF_PROVIDER
npm start
```

- Painel admin (QR Codes, espaços e check-ins): `http://localhost:3000/admin`
- Cada espaço tem um QR Code assinado (`/?l=<espaço>&k=<assinatura>`). Sem um QR válido, o check-in não abre.

## Consulta de CPF

A Receita Federal **não tem API pública gratuita** de CPF → nome. A fonte oficial é a API **Consulta CPF do SERPRO**, que é paga por consulta. Por isso o sistema aceita vários provedores (`CPF_PROVIDER` no `.env`):

| Provedor | Uso |
|---|---|
| `mock` | Nomes fictícios, para desenvolvimento |
| `serpro` + `SERPRO_TRIAL=true` | Ambiente de demonstração gratuito do SERPRO. Só responde aos CPFs de teste da documentação (ex.: `404.428.201-35`) |
| `serpro` + chaves | Produção: contrate em loja.serpro.gov.br e preencha `SERPRO_CONSUMER_KEY/SECRET` |
| `custom` | Qualquer provedor HTTP com token (Didit, Direct Data, Infosimples…): configure `CPF_API_URL`, `CPF_API_HEADERS` e `CPF_API_NAME_PATH` |

### SERPRO (provedor configurado)

- **Teste (`SERPRO_TRIAL=true`)**: gratuito, só com CPFs fictícios do SERPRO e com limite de chamadas por segundo. Exemplos: `404.428.201-35` (Regular), `630.172.859-95` (Regular), `581.360.533-91` (Regular), `471.235.869-64` (Suspensa), `109.753.846-00` (Pendente). Qualquer outro CPF retorna "não encontrado".
- **Produção**: contrate a API **Consulta CPF** em loja.serpro.gov.br. Na Área do Cliente, copie a *Consumer Key* e o *Consumer Secret* para o `.env`, troque para `SERPRO_TRIAL=false` e reinicie (`npm start`).
- CPFs com situação **Titular Falecido, Nula ou Cancelada** são recusados no check-in. Suspensa e Pendente de Regularização são aceitas, e a situação aparece para o usuário e fica registrada.

O token do provedor fica só no servidor. Os nomes salvos no check-in vêm do servidor, nunca do navegador.

## Publicar com HTTPS

Os celulares só liberam a câmera para a selfie em **HTTPS**. O sistema grava os dados em disco (`data/`), então precisa de um servidor com disco que não se apague, como um VPS.

### VPS Ubuntu + Caddy (recomendado)

1. No painel do domínio, crie um registro **A**: `checkin` → IP do VPS.
2. No VPS, por SSH:

```bash
curl -fsSL https://raw.githubusercontent.com/coremapsolutionstec-wq/checkinokay/main/deploy/install.sh -o install.sh
sudo bash install.sh checkin.seudominio.com.br
```

O script instala Node.js e Caddy (HTTPS automático com Let's Encrypt), cria um usuário só para o sistema, gera o `.env` com uma senha de admin aleatória, registra o serviço (que sobe sozinho ao reiniciar o servidor) e libera no firewall só SSH, 80 e 443. No final ele mostra a senha do admin.

3. Edite `/opt/checkinokay/.env` com as chaves do SERPRO (`SERPRO_TRIAL=false`) e reinicie:

```bash
sudo systemctl restart checkinokay
```

4. Abra `https://checkin.seudominio.com.br/admin` e imprima os QR Codes.

**Atualizar** depois de novos commits: rode `sudo bash install.sh checkin.seudominio.com.br` de novo. Ele baixa o código novo e reinicia, sem mexer no `.env` nem nos dados.

**Logs:** `journalctl -u checkinokay -f`. **Backup:** copie periodicamente `/opt/checkinokay/data` e `/opt/checkinokay/.env`.

Arquivos usados: [deploy/install.sh](deploy/install.sh), [deploy/checkinokay.service](deploy/checkinokay.service), [deploy/Caddyfile](deploy/Caddyfile).

### Alternativa: Cloudflare Tunnel

Para rodar em um computador do próprio OKAY, sempre ligado, sem abrir portas no roteador: com o domínio no Cloudflare, instale o `cloudflared`, crie um túnel apontando para `http://localhost:3000` e use `HOST=127.0.0.1`, `TRUST_PROXY=true` e `PUBLIC_URL=https://seu-dominio` no `.env`. Se o computador desligar, o check-in para.

Se o navegador bloquear a câmera, o sistema oferece abrir a câmera nativa do celular.

## Dados

Tudo fica em `data/` (fora do git):

- `locais.json`: espaços e capacidade
- `checkins.json`: registros (titular, participantes, aceite do termo com hash do texto, data, IP)
- `selfies/`: fotos (acessíveis só pelo admin)
- `termo.md`: texto do termo (edite à vontade)
- `secret.txt`: segredo dos QR Codes (se for trocado, todos os QR Codes precisam ser reimpressos)

Dados pessoais (CPF + selfie) estão sujeitos à LGPD: defina um prazo de retenção e um canal para pedidos dos titulares.
