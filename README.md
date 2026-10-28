# R2PHARMA WhatsApp Bridge

Serviço externo e persistente para executar `whatsapp-web.js` em uma máquina controlada pela R2PHARMA e integrar o estado da sessão ao console principal.

> **Importante:** este pacote não contém credenciais, token, QR Code, sessão WhatsApp ou dados do cliente. O primeiro pareamento acontece somente na máquina do cliente, depois que o operador configurar os segredos por canal seguro.

## O que este pacote entrega

O serviço executa `whatsapp-web.js` com Chromium em processo persistente e `LocalAuth` em volume persistente. Ele expõe a mesma ponte HTTPS que a aplicação principal já consome:

| Método | Endpoint | Finalidade |
| --- | --- | --- |
| `GET` | `/v1/session/status` | Estado da sessão, heartbeat e conta somente quando conectada |
| `GET` | `/v1/session/qrcode` | QR Code efêmero em `data:` URL, sem persistência |
| `POST` | `/v1/session/conectar` | Solicita o início da sessão e a geração do QR Code |
| `POST` | `/v1/session/sincronizar` | Descoberta e persistência local dos grupos |
| `POST` | `/v1/session/reiniciar` | Reinício do cliente WhatsApp |
| `POST` | `/v1/session/desconectar` | Logout e remoção dos dados locais de autenticação |
| `POST` | `/v1/messages/send` | Envio protegido a um grupo, com `delivery_id` estável opcional para deduplicação |

Todas as rotas `/v1/*` exigem `Authorization: Bearer <BRIDGE_TOKEN>`. As rotas `/healthz` e `/readyz` não revelam informações da conta e podem ser usadas pelo monitoramento local.

A integração imediata com o console é a tela **Sessão WhatsApp**: depois de configurar a URL HTTPS e o token no backend da aplicação, ela consulta status/QR e executa conexão, sincronização, reinício e desconexão por esta ponte. Quedas involuntárias iniciam reconexão progressiva ilimitada, com teto de 60 segundos entre tentativas, até que uma desconexão manual cancele o ciclo. O serviço não altera diretamente o banco do console. O envio massivo HU-022 usa `delivery_id` derivado da comunicação e do destino; o ledger persistente devolve o mesmo resultado quando a aplicação repete uma tentativa.

## Build Docker/Render

Este artefato é um **overlay completo dos arquivos modificados da bridge** para aplicar sobre a distribuição-base já existente. Ele inclui `package.json`, os quatro scripts de patch, o arquivo `scripts/wwebjs-201832.patch`, código, testes e documentação modificados. Não inclui `package-lock.json` não modificado, `Dockerfile`, configurações de proxy não modificadas, `node_modules`, imagem OCI, `docker-compose.yml`, tarball de imagem, sessão WhatsApp ou credenciais. Aplique-o somente sobre a base compatível da mesma bridge e não execute `docker load` com este ZIP.

No Render, extraia o ZIP sobre o contexto completo já existente, revise o inventário e o diff e então faça um novo deploy manual. Em uma instalação Docker externa, aplique o overlay ao pacote-base aprovado pelo cliente e preserve o volume persistente de `/data`.

Na distribuição-base, durante `npm ci`/`npm install`, o `postinstall` aplica quatro backports version-gated e idempotentes sobre `whatsapp-web.js@1.34.7`: compatibilidade de IDs `_serialized`/`$1`, remoção da colisão privada `MediaData.__x_id` antes da criação da mensagem outbound, recuperação do modelo resolvido por `msgPromise` antes da consulta de coleção e MIME explícito no download de mídia. Este overlay altera o `SessionManager`: para mídia/documentos, o serviço não ativa `waitUntilMsgSent`, pois a confirmação interna do build atual pode lançar `MESSAGE_ID_MISSING` depois de o cliente já ter aceitado localmente; a bridge ainda exige um ID string verificável no retorno antes de confirmar. Texto continua aguardando `waitUntilMsgSent`. Os patches da base recusam versões ou shapes desconhecidos antes de escrever. O conjunto não cria ID artificial, não confirma entrega sem ID e não altera sessão ou ledger.

### Limite desta versão

A aplicação principal registra respostas de tickets como `enfileirada` e não possui um worker geral de saída conectado a esta ponte. A HU-022, porém, possui um fluxo específico de comunicação massiva: após aprovação obrigatória para criticidade crítica, o backend chama `/v1/messages/send`, controla ritmo, reserva cada destino e registra o resultado. O envio continua fail-closed quando a sessão não está conectada; o teste controlado com a conta corporativa ainda é necessário antes de declarar a operação produtiva.

## Requisitos do cliente

- Máquina Linux persistente, preferencialmente Ubuntu 22.04+ ou equivalente.
- Docker Engine + Compose plugin, **ou** Node.js 22, Chromium e systemd.
- Volume persistente e backup protegido para `/data`.
- DNS para um hostname da ponte, por exemplo `whatsapp-bridge.<dominio-do-cliente>`.
- Certificado TLS válido no proxy reverso.
- Conectividade de saída para o WhatsApp Web e acesso HTTPS do backend da aplicação principal ao hostname da ponte.
- Conta corporativa autorizada pela R2PHARMA para usar **WhatsApp → Aparelhos conectados → Conectar aparelho**.

A documentação oficial do `whatsapp-web.js` exige Node.js 18 ou superior e informa que `LocalAuth` precisa de um sistema de arquivos persistente para restaurar a sessão. A imagem deste pacote usa Node.js 22, Chromium do sistema e volume Docker persistente.

## Implantação recomendada com Docker

### 1. Copiar os arquivos

Envie o ZIP de correção ao repositório/contexto conectado ao Render ou extraia-o em um diretório operacional, por exemplo `/opt/r2pharma-whatsapp-bridge`. Preserve o `Dockerfile` na raiz e revise o diff antes do build. Este overlay não substitui o volume `/data` nem a configuração de segredos do ambiente.

### 2. Gerar e guardar o token

No diretório do pacote, execute:

```bash
chmod +x scripts/generate-token.mjs
npm run token
```

Guarde a saída em um cofre corporativo. O mesmo valor será cadastrado no `.env` da ponte e no segredo do backend da aplicação principal. **Nunca envie o token por chat, commit, e-mail sem proteção ou log.**

### 3. Criar a configuração local

O repositório inclui somente exemplos sem segredos; nunca versiona o `.env` real. No Render, configure as variáveis no painel de Environment/Secrets; em instalação Node externa, crie o `.env` somente na máquina do cliente, com permissão restrita.

Edite apenas na máquina do cliente:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3002
BRIDGE_TOKEN=<token-gerado-no-passo-anterior>
R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS=180000
WHATSAPP_AUTH_PATH=/data/.wwebjs_auth
WHATSAPP_GROUPS_PATH=/data/groups.json
# Política de grupos. Com true, qualquer identificador técnico @g.us é aceito.
WHATSAPP_ALLOW_ANY_GROUPS=true
# Usado somente no modo manual (WHATSAPP_ALLOW_ANY_GROUPS=false).
WHATSAPP_ALLOWED_GROUP_IDS=
WHATSAPP_DELIVERY_LEDGER_PATH=/data/delivery-ledger.json
WHATSAPP_DELIVERY_LEDGER_TTL_SECONDS=2592000
WHATSAPP_DELIVERY_LEDGER_MAX_ENTRIES=10000
WHATSAPP_CLIENT_ID=r2pharma-principal
CHROME_EXECUTABLE_PATH=/usr/bin/chromium
```

O serviço descobre todos os grupos da conta corporativa. Com `WHATSAPP_ALLOW_ANY_GROUPS=true`, o envio aceita qualquer `canal_grupo_id` que corresponda estritamente ao formato técnico `@g.us`; chats individuais, identificadores malformados e valores sem o sufixo correto continuam bloqueados. Essa é uma política ampla autorizada pelo owner e deve ser usada somente quando o cliente aceitar que novos grupos recebam outbound sem aprovação individual. Com a flag ausente ou `false`, o serviço volta ao modo manual: `WHATSAPP_ALLOWED_GROUP_IDS` é um CSV estrito, sem itens vazios ou duplicados, e é obrigatório e não vazio em produção. Novos grupos continuam entrando como **Sem cliente** no console; no modo amplo, o status cadastral não bloqueia o envio. Entradas confirmadas do ledger são compactadas após 30 dias e acima de 10.000 entradas, por ordem determinística; estados `uncertain` e `in_progress` são preservados e bloqueiam reenvio silencioso até reconciliação.

### 4. Iniciar e verificar localmente

```bash
npm ci --omit=dev
npm run check
npm start
curl --fail http://127.0.0.1:3002/healthz
curl --fail http://127.0.0.1:3002/readyz
```

O primeiro `readyz` pode indicar sessão `desconectado`; isso é esperado antes do QR ser lido. Verifique os logs sem imprimir o `.env`:

Consulte o mecanismo de logs do serviço usado pelo ambiente (Render, systemd ou serviço Windows), sem imprimir o `.env`.

Os logs não devem conter QR Code, token, conteúdo de mensagens ou dados completos de conversa.

Em falhas de envio, procure primeiro `whatsapp_message_send_started` e `whatsapp_message_send_returned`: eles informam apenas o tipo (`text`, `media` ou `document`), se o objeto e o campo de ID existiam, o tipo dos campos `_serialized`/`$1` e se eram não vazios; não registram o valor do ID, payload, telefone ou token. Depois procure `whatsapp_message_send_failure`: `send_phase` distingue chamada ainda sem retorno (`calling_client_text`/`calling_client_media`), retorno sem ID (`returned_without_id_text`/`returned_without_id_media`) e outras falhas; o evento mantém somente `error_code` operacional allowlisted (`SEND_FAILED` ou `MESSAGE_ID_MISSING`) e diagnóstico categorizado com fingerprint SHA-256 curto, além de `attachments_count`, `message_ids_count` e `quoted`. O evento HMAC `message_send_failure` enviado ao console aceita somente esse contrato e o console deve responder HTTP 202, criando apenas o alerta/auditoria operacional correspondente. O erro de observabilidade não altera o resultado do envio nem libera retry automático.

### 5. Configurar HTTPS

Não publique a porta 3002 diretamente na internet. Use o exemplo em `deploy/nginx/r2pharma-whatsapp-bridge.conf.example`, instale-o no Nginx do cliente e configure o certificado TLS corporativo ou ACME. O proxy deve encaminhar para `127.0.0.1:3002`. Preserve `client_max_body_size 160m`, `proxy_read_timeout 180s` e `proxy_send_timeout 180s`: um documento de 100 MiB ocupa aproximadamente 133 MiB em base64, além do envelope JSON. O `R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS` padrão também é 180 segundos para permitir a gravação SQL Server de documentos grandes.

Depois de ativar o DNS e o certificado, teste a ponte:

```bash
curl --fail https://whatsapp-bridge.<dominio-do-cliente>/healthz
curl --fail \
  -H "Authorization: Bearer <token>" \
  https://whatsapp-bridge.<dominio-do-cliente>/v1/session/status
```

O segundo comando deve retornar JSON com `id: "principal"`, `servico_alcancavel: true` e um estado de sessão sem expor número da conta quando ainda não houver conexão.

### 6. Configurar a aplicação principal

No ambiente do backend da aplicação R2PHARMA, cadastre os dois valores **somente como segredo/configuração de servidor**:

```dotenv
WHATSAPP_SESSION_SERVICE_URL=https://whatsapp-bridge.<dominio-do-cliente>
WHATSAPP_SESSION_SERVICE_TOKEN=<mesmo-token-do-bridge>
```

A aplicação principal aceita somente URL HTTPS e não envia esse token para o navegador. Não coloque esses valores em `VITE_*`, no frontend, em um arquivo versionado ou no chat.

### 7. Fazer o primeiro pareamento

1. Abra a área administrativa de Sessão WhatsApp no console.
2. Confirme que o status do serviço externo está alcançável.
3. Aguarde o QR Code aparecer; ele é efêmero e pode expirar.
4. Na conta corporativa, abra **WhatsApp → Aparelhos conectados → Conectar aparelho**.
5. Leia o QR Code.
6. Aguarde o estado `conectado` e confirme que o número/nome aparecem somente nesse estado.
7. Execute **Sincronizar grupos** e valide a contagem retornada.
8. Registre o hostname, versão do pacote, data do pareamento e resultado do teste controlado.

## Operação e recuperação

### Reinício

```bash
docker compose restart whatsapp-bridge
```

A sessão deve ser restaurada pelo `LocalAuth` sem novo QR, desde que o volume `r2pharma_whatsapp_auth` esteja intacto.

### Desconexão administrativa

A ação `POST /v1/session/desconectar` chama logout e remove o diretório de autenticação da sessão. Depois disso, um novo pareamento por QR será necessário. Trate essa ação como destrutiva para a sessão e restrinja o token e o acesso ao console por RBAC.

### Backup

Faça backup criptografado do volume de autenticação conforme a política da R2PHARMA. Exemplo de cópia para um arquivo local protegido, substituindo o destino por armazenamento corporativo aprovado:

```bash
docker run --rm \
  -v r2pharma_whatsapp_auth:/data:ro \
  -v /var/backups/r2pharma:/backup \
  alpine:3.20 \
  tar czf /backup/whatsapp-auth-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

O backup contém material sensível de sessão e deve ter acesso restrito. Teste restauração em máquina isolada; não restaure sobre a sessão de produção sem janela e autorização.

### Atualização

1. Faça backup e registre o estado atual.
2. Pare o serviço.
3. Substitua o diretório do pacote pelo novo pacote revisado.
4. Preserve o volume `r2pharma_whatsapp_auth`.
5. Inicie o serviço pelo mecanismo aprovado do ambiente (Render, systemd ou serviço Windows), sem apagar o volume persistente.
6. Verifique `/healthz`, `/readyz`, `/v1/session/status` e os logs.
7. Se houver falha, volte à imagem anterior e preserve os logs.

## Segurança operacional

- Mantenha a porta Node ligada apenas em loopback quando houver Nginx.
- Restrinja a porta 443 por firewall/allowlist se a arquitetura permitir.
- Use token aleatório com pelo menos 32 caracteres e rotação planejada.
- Nunca registre `Authorization`, QR Code, conteúdo de mensagem, número completo ou diretório de sessão.
- Não monte `/data` em um compartilhamento público.
- Execute com usuário não-root; o Dockerfile usa o usuário `node`.
- Preserve TLS válido ponta a ponta entre a aplicação principal e o proxy.
- Aplique backups e retenção corporativos ao volume de autenticação.
- Monitore `healthz`, `readyz`, reinícios do container, `auth_failure`, `disconnected` e `whatsapp_client_failure`.
- Não compartilhe o QR Code por captura de tela ou canal de suporte; ele vincula uma conta corporativa.

## Testes incluídos

O pacote inclui testes de contrato HTTP que verificam health público, bloqueio sem Bearer token, respostas de status/QR e ações protegidas. Eles não inicializam Chromium nem vinculam uma conta real.

Na distribuição-base, as regressões do patch de mídia verificam documento com citação, preservação de `sendMediaAsDocument`, retorno direto por `msgPromise` com `_serialized`/`$1`, fallback atrasado, bypass seguro da confirmação interna de mídia, ausência de ID sem falso sucesso, aplicação idempotente, CRLF e falha fechada para versão/shape ou aplicação parcial incompatíveis. O arquivo de teste incluído neste overlay é a regressão específica do `SessionManager`; a suíte completa precisa ser executada após aplicar o overlay sobre a base. O teste real com a conta corporativa continua sendo uma etapa separada de homologação.

```bash
npm ci
npm run check
npm test
```

O teste de integração real deve ser executado na máquina homologatória do cliente, com uma conta autorizada e janela controlada: QR, `ready`, reboot com restauração, sincronização de grupos e logout.

## Revisão de segurança obrigatória

O pacote inclui um risco upstream declarado em [`SECURITY.md`](./SECURITY.md): a instalação limpa atual reportou 14 vulnerabilidades transitivas (2 moderadas e 12 altas, sem críticas) na cadeia do Puppeteer usada pelo `whatsapp-web.js`. O npm propõe uma correção forçada não validada; ela não foi aplicada. A implantação é um **candidato técnico**, não uma aprovação de produção. O cliente deve revisar/aceitar o risco ou aguardar versões compatíveis, além de executar a varredura da imagem no próprio ambiente.

## Referências

- [Instalação oficial do whatsapp-web.js](https://wwebjs.dev/guide/installation)
- [Autenticação oficial e LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html)
- [Documentação da classe LocalAuth](https://docs.wwebjs.dev/LocalAuth.html)
- Contrato da ponte no console R2PHARMA: `docs/whatsapp-web-js-bridge.md` no repositório da aplicação principal.

## Estado de produção

Este pacote é um candidato implantável; a produção ainda depende da infraestrutura do cliente, configuração segura do token e URL, certificado TLS, backup, revisão de segurança, leitura do QR e homologação. A integração não deve ser declarada como ativa antes desses testes. O pacote não executa automaticamente qualquer ação externa de alto impacto sem a configuração e a operação humana na máquina do cliente.
