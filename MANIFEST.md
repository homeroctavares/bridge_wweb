# Manifesto de distribuição externa

**Pacote:** R2PHARMA WhatsApp Bridge 1.1.0 — pacote-fonte externo
**Trace:** `TRACE-R2PHARMA-BRIDGE-PACKAGE-20261023`

## Incluído

- Código da bridge em `src/`.
- `package.json` e `package-lock.json` para instalação determinística.
- `scripts/generate-token.mjs` para geração local do token.
- `scripts/patch-wwebjs-201832.cjs` e `scripts/wwebjs-201832.patch` para o backport reproduzível executado pelo `postinstall`.
- `Dockerfile` e `docker-compose.yml` com build local, usuário não-root, volume persistente e porta Node somente em loopback.
- `deploy/iis/` para Windows Server + IIS/ARR/NSSM aprovado pelo cliente.
- `deploy/nginx/` e `deploy/systemd/` para Linux externo.
- Testes em `test/` e documentação operacional/segurança.
- `evidence/work-item.json`, `PACKAGE-MANIFEST.json`, `PACKAGE-SHA256SUMS.txt` e logs de validação do pacote.

## Não incluído deliberadamente

- Imagem OCI pré-construída; o daemon Docker não estava disponível no sandbox. O cliente deve executar `docker compose build` no ambiente externo ou construir a imagem no pipeline aprovado.
- `node_modules`, `.env` real, token Bearer, segredo HMAC, URL privada, certificados e chaves privadas.
- QR Code, sessão `LocalAuth`, contatos, grupos, mensagens ou dados do cliente.
- `scripts/start-development-manus.sh` e qualquer inicializador específico do Manus.
- Binário NSSM, Node.js, Chrome/Chromium ou componentes do IIS/Nginx.
- Acesso a servidores, DNS, firewall, banco ou aprovação de produção.

## Validação do pacote

- `npm ci --omit=dev`: aprovado; o `postinstall` aplicou o backport.
- `npm run check`: aprovado.
- `npm test`: 19 testes aprovados.
- Patcher idempotente: aprovado, segunda execução ignorada porque a dependência já estava normalizada.
- Auditoria: 9 vulnerabilidades altas e 1 moderada foram reportadas; o risco está documentado em `SECURITY.md` e bloqueia declaração de produção aprovada.
- Não foram executados Chromium real, QR Code, pareamento, restauração de sessão ou mensagens WhatsApp.
