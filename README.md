# R2PHARMA WhatsApp Bridge — Pacote externo 1.1.0

Este é um pacote-fonte reproduzível para instalação da bridge WhatsApp em infraestrutura externa controlada pela R2PHARMA ou por outro operador autorizado. O pacote não depende do Manus e não contém credenciais, token Bearer, segredo HMAC, QR Code, sessão WhatsApp, certificados, chave privada, contatos, grupos, mensagens ou `node_modules`.

## Modos de implantação

O pacote inclui três alternativas. Escolha uma única alternativa por ambiente:

- **Docker + proxy TLS**: `Dockerfile`, `docker-compose.yml` e exemplos Nginx. O ambiente externo executa `docker compose build` localmente; a imagem OCI pronta não está incluída.
- **Windows Server + IIS/ARR**: `deploy/iis/`, Node.js 22, Chromium/Chrome e serviço Windows por NSSM aprovado pelo cliente. O IIS publica HTTPS e o Node permanece em `127.0.0.1:3002`.
- **Linux + systemd/Nginx**: `deploy/systemd/` e `deploy/nginx/`, com Node.js 22, Chromium e volume persistente.

Não misture os arquivos de serviço entre as alternativas. Em todos os modos, a sessão WhatsApp exige armazenamento persistente para `WHATSAPP_AUTH_PATH`.

## Conteúdo

A raiz contém o código em `src/`, os testes em `test/`, `package.json`, `package-lock.json`, `Dockerfile`, Compose, exemplos de configuração, scripts de token e o backport reproduzível `scripts/patch-wwebjs-201832.cjs` com seu patch. A distribuição Windows/IIS fica em `deploy/iis/`; a Linux fica em `deploy/systemd/` e `deploy/nginx/`.

O script `scripts/start-development-manus.sh` foi deliberadamente excluído. A execução externa deve usar o mecanismo do próprio ambiente, nunca um inicializador do Manus.

## Instalação Docker

No servidor externo, extraia o pacote, copie `.env.example` para `.env`, gere o token no próprio servidor e preencha a configuração por canal seguro:

```bash
cp .env.example .env
chmod 600 .env
node scripts/generate-token.mjs
# edite .env somente no servidor externo
sudo docker compose build --pull=false
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:3002/healthz
curl --fail http://127.0.0.1:3002/readyz
```

A variável `R2PHARMA_EVENT_WEBHOOK_URL` deve apontar para o endpoint HTTPS real da aplicação e `R2PHARMA_EVENT_WEBHOOK_SECRET` deve ser um segredo HMAC diferente do `BRIDGE_TOKEN`. Nunca coloque esses valores no pacote ou no frontend.

O Compose publica a porta Node somente em loopback e mantém `/data` em volume persistente. O proxy TLS externo deve publicar apenas 443 e encaminhar para `127.0.0.1:3002`. Não exponha a porta 3002 na rede.

## Instalação Windows/IIS

Use `README-IIS.md`, `MANIFEST-IIS.md` e `deploy/iis/README.md`. O fluxo mínimo é:

```powershell
$InstallDir = 'C:\Program Files\R2PHARMA\WhatsAppBridge'
Set-Location $InstallDir
npm ci --omit=dev
npm run check
npm test
node scripts/generate-token.mjs
```

Depois, crie o diretório persistente de dados, configure `.env` a partir de `deploy/iis/.env.windows.example`, instale o serviço pelo script aprovado com NSSM e publique o site IIS com URL Rewrite + ARR. O IIS deve encaminhar para `http://127.0.0.1:3002` e não deve publicar `.env`, `auth`, logs ou dados de sessão.

## Validação obrigatória no ambiente externo

Após instalar dependências, execute:

```bash
npm run check
npm test
```

Depois valide `/healthz`, `/readyz`, `/v1/session/status` com Bearer token, QR efêmero, pareamento, reinício com restauração de `LocalAuth`, sincronização de grupos e logout em janela controlada. O primeiro pareamento deve ser executado somente na máquina autorizada pelo cliente.

O `npm ci --omit=dev` executa o `postinstall` e aplica o backport do whatsapp-web.js quando necessário. O patcher é idempotente. Se o patcher informar árvore parcialmente aplicada, remova somente o `node_modules/whatsapp-web.js` incompleto, reinstale o pacote pelo `package-lock.json` e repita a instalação; não ignore o erro.

## Persistência, backup e atualização

O diretório persistente contém a autenticação WhatsApp, catálogo local de grupos e ledger de entrega. Faça backup criptografado e restrito conforme a política do cliente. Teste restauração em ambiente isolado antes de restaurar em produção. Atualizações devem preservar o volume de dados, executar os checks, reiniciar uma única instância e verificar a saúde antes de qualquer pareamento ou operação real.

## Segurança e limitações

`SECURITY.md` registra o risco upstream; nesta validação do pacote, `npm audit --omit=dev --audit-level=high` encontrou 9 vulnerabilidades altas e 1 moderada. O pacote é um candidato técnico e não constitui aprovação de produção. O cliente deve executar sua própria varredura da imagem e revisar o risco antes do uso. Não execute `npm audit fix --force` sem validar novamente o whatsapp-web.js e o patch de compatibilidade.

A bridge captura eventos novos recebidos enquanto está conectada; sincronização de catálogo de grupos não importa automaticamente histórico anterior. O envio de mensagens reais, o pareamento e o logout não são executados durante a preparação deste pacote.

## Não incluído

Não estão incluídos imagem OCI, Node.js, Chromium, IIS, ARR, Nginx, NSSM, certificados, DNS, firewall, `.env` real, tokens, segredos, QR, sessão, dados do cliente ou aprovação de produção. Esses itens pertencem ao ambiente externo e à equipe autorizada.

## Proveniência desta entrega

Consulte `PACKAGE-MANIFEST.json`, `PACKAGE-SHA256SUMS.txt` e `SECURITY.md`. O arquivo `PACKAGE-MANIFEST.json` registra o trace da entrega, os arquivos incluídos, os arquivos excluídos e os checks executados no sandbox. O checksum externo do ZIP deve ser conferido antes de transferi-lo.
