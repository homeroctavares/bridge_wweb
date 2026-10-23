# Manifesto de distribuição — Windows Server + IIS

**Pacote:** R2PHARMA WhatsApp Bridge 1.1.0 — distribuição Windows/IIS
**Destino informado:** servidor `192.168.1.155`
**Arquitetura:** Node.js persistente em `127.0.0.1:3002` + IIS/ARR em HTTPS `443`

**Revisão funcional incluída:** HU-001 V1.1 — descoberta de todos os grupos, eventos HMAC de sessão, captura de mensagens de grupos e resposta automática a conversas individuais.

## Incluído

- Código da bridge em `src/`.
- `package.json` e `package-lock.json` para instalação determinística.
- `scripts/generate-token.mjs` para gerar o token localmente.
- Testes de contrato em `test/`.
- `deploy/iis/README.md` com instalação, IIS, DNS, firewall, QR, atualização e recuperação.
- `deploy/iis/.env.windows.example` sem segredo.
- `deploy/iis/web.config` pronto e `deploy/iis/web.config.example` de referência para URL Rewrite/ARR.
- Scripts PowerShell de instalação, remoção e health check.
- `SECURITY.md` com risco upstream e controles obrigatórios.
- `README.md` e `MANIFEST.md` do pacote principal para referência.

## Não incluído deliberadamente

- `node_modules`; instalar no Windows com `npm ci --omit=dev`.
- `.env` real, token Bearer, URL privada, certificados e chaves privadas.
- QR Code, sessão `LocalAuth`, contatos, grupos, mensagens ou dados do cliente.
- Binário NSSM, instalador de Node.js, Chrome/Chromium ou componentes do IIS.
- Acesso ao servidor `192.168.1.155` ou ao DNS da R2PHARMA.
- Aprovação de produção.

## Validação do pacote

- `npm run check` aprovado no ambiente de desenvolvimento.
- `npm test` aprovado sem iniciar Chromium ou vincular conta real.
- A configuração Node/IIS mantém o serviço interno em loopback e publica somente HTTPS pelo IIS.
- O guia IIS inclui o webhook HTTPS assinado para `https://customer.r2pharma.com/api/bridge/events`, sem inserir valores de token ou segredo no pacote.
- O primeiro pareamento, QR Code, reconexão, sincronização e logout devem ser homologados no ambiente da R2PHARMA.
