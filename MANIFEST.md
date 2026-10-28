# Manifesto de entrega

**Pacote:** R2PHARMA WhatsApp Bridge 1.1.0 — pacote completo de arquivos modificados

## Conteúdo do ZIP

O pacote contém os arquivos modificados da bridge relacionados à autorização de grupos, ledger, envio documental, diagnóstico e confirmação de mídia, além do `package.json` e de toda a cadeia de patches necessária:

```text
.dockerignore
.gitignore
MANIFEST.md
README.md
SECURITY.md
package.json
scripts/patch-wwebjs-201832.cjs
scripts/patch-wwebjs-media-id.cjs
scripts/patch-wwebjs-media-id-return.cjs
scripts/patch-wwebjs-media-mime.cjs
scripts/wwebjs-201832.patch
src/config.js
src/server.js
src/session-manager.js
test/config.test.js
test/media-id-patch.test.js
test/media-id-return-patch.test.js
test/media-mime-patch.test.js
test/server.test.js
test/session-manager.test.js
```

`package.json` executa, em sequência, `patch-wwebjs-201832.cjs`, `patch-wwebjs-media-id.cjs`, `patch-wwebjs-media-id-return.cjs` e `patch-wwebjs-media-mime.cjs`. O patch 201832 usa `scripts/wwebjs-201832.patch`; por isso esse arquivo acompanha o script no ZIP.

O pacote é um overlay e não uma distribuição autônoma. Arquivos não modificados, incluindo exemplos de ambiente, `package-lock.json`, `Dockerfile`, configurações de proxy, `deploy/iis`, `src/index.js`, `src/logger.js`, `docker-compose.yml` e dependências instaladas, devem permanecer na distribuição-base compatível.

## Não incluído deliberadamente

Arquivos `.env` e exemplos de ambiente, token Bearer, certificado, chave privada, URL do cliente, QR Code, LocalAuth, cache do WhatsApp Web, volume `/data`, sessão WhatsApp, dados reais de grupos/contatos/mensagens, `node_modules`, imagem OCI, tarball de imagem, acesso à infraestrutura ou ao banco da R2PHARMA.

## Validação realizada no sandbox

- `npm test`: 78 testes aprovados.
- `npm run check` e `node --check`: aprovados.
- `npm run postinstall`: os quatro patches foram reconhecidos como aplicados/idempotentes.
- `npm audit --omit=dev`: 14 vulnerabilidades transitivas observadas, sendo 2 moderadas e 12 altas; risco documentado fora deste pacote.
- Composição do ZIP, teste de integridade, hashes e scan focal de segredos: aprovados.
- Build de imagem, smoke de container, QR, Chromium, pareamento, restauração de sessão real, Render e envio WhatsApp não foram executados.

Este pacote não representa publicação ou aprovação de produção. A publicação permanece manual e depende de revisão do diff, build no Render e homologação controlada.
