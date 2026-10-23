# R2PHARMA WhatsApp Bridge — Windows Server + IIS

Este diretório contém a distribuição para o servidor `192.168.1.155` quando o cliente utiliza **IIS como proxy reverso HTTPS**. O IIS não executa o processo Node: a bridge roda como serviço Windows em `127.0.0.1:3002`, e o IIS publica o hostname `whatsapp-bridge.r2pharma.com` na porta 443.

## Pré-requisitos

- Windows Server 2019 ou 2022 x64.
- Node.js 22.x LTS para Windows.
- Google Chrome ou Chromium instalado para uso pelo `whatsapp-web.js`.
- IIS, URL Rewrite e Application Request Routing (ARR).
- Certificado TLS válido para `whatsapp-bridge.r2pharma.com` instalado no servidor IIS.
- NSSM aprovado pela equipe da R2PHARMA para transformar o processo Node em serviço Windows.
- Permissão administrativa no servidor e autorização para criar o serviço, site IIS e regras de firewall.
- DNS interno corporativo apontando `whatsapp-bridge.r2pharma.com` para `192.168.1.155`.

## 1. Copiar e validar o pacote

Extraia o ZIP para um diretório de instalação, por exemplo:

```powershell
$InstallDir = 'C:\Program Files\R2PHARMA\WhatsAppBridge'
New-Item -ItemType Directory -Force -Path $InstallDir
```

Copie os arquivos do pacote para `$InstallDir`. Abra PowerShell como administrador e valide:

```powershell
Set-Location $InstallDir
node --version
npm --version
npm ci --omit=dev
npm run check
npm test
```

O pacote não inclui `node_modules`; o `npm ci` deve ser executado no servidor usando o `package-lock.json` fornecido. Não use `npm audit fix --force` sem revisão e regressão de `whatsapp-web.js`.

## 2. Criar diretório persistente e configuração

A sessão do WhatsApp não pode ficar dentro de diretório temporário ou do perfil de usuário. Crie:

```powershell
$DataDir = 'C:\ProgramData\R2PHARMA\WhatsAppBridge'
New-Item -ItemType Directory -Force -Path "$DataDir\auth", "$DataDir\logs"
Copy-Item "$InstallDir\deploy\iis\.env.windows.example" "$InstallDir\.env"
notepad "$InstallDir\.env"
```

Ajuste no `.env` somente no servidor do cliente:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3002
BRIDGE_TOKEN=valor-gerado-e-armazenado-no-cofre
WHATSAPP_AUTH_PATH=C:/ProgramData/R2PHARMA/WhatsAppBridge/auth
WHATSAPP_GROUPS_PATH=C:/ProgramData/R2PHARMA/WhatsAppBridge/groups.json
WHATSAPP_CLIENT_ID=r2pharma-principal
CHROME_EXECUTABLE_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe
PUPPETEER_HEADLESS=true
```

Gere o token sem inventar um valor manualmente:

```powershell
node scripts/generate-token.mjs
```

Guarde o resultado no cofre corporativo e use o mesmo valor apenas no `.env` da bridge e no segredo server-side da aplicação principal. Não envie o token por chat, e-mail sem proteção ou repositório.

Restrinja o `.env` e o diretório de sessão ao serviço e aos administradores. O script `install-service.ps1` aplica ACLs ao diretório de dados e ao `.env`.

## 3. Instalar como serviço Windows

Baixe e instale o NSSM a partir da fonte aprovada pela R2PHARMA. Não coloque o executável NSSM no pacote sem aprovação de licença e origem.

Com o NSSM, execute:

```powershell
Set-Location $InstallDir
.\deploy\iis\install-service.ps1 `
  -InstallDir $InstallDir `
  -DataDir 'C:\ProgramData\R2PHARMA\WhatsAppBridge' `
  -NssmPath 'C:\Tools\nssm\nssm.exe'
```

A conta padrão do script é `NT AUTHORITY\NetworkService`. Se a política exigir uma conta de serviço dedicada, crie-a pela rotina corporativa e ajuste a conta do serviço antes de iniciar.

Valide o serviço e a saúde local:

```powershell
Get-Service R2PHARMA-WhatsAppBridge
Invoke-RestMethod http://127.0.0.1:3002/healthz
Invoke-RestMethod http://127.0.0.1:3002/readyz
```

O estado `desconectado` no `readyz` antes do primeiro QR Code é esperado. As rotas `/v1/*` sempre exigem Bearer token.

## 4. Configurar o IIS como proxy reverso

1. Instale **IIS**, **URL Rewrite** e **Application Request Routing** conforme o procedimento aprovado pela R2PHARMA.
2. No IIS Manager, selecione o servidor, abra **Application Request Routing Cache** e entre em **Server Proxy Settings**.
3. Marque **Enable proxy** e aplique.
4. Crie um diretório físico, por exemplo:

```text
C:\inetpub\r2pharma-whatsapp-bridge
```

5. Copie `deploy\iis\web.config` para esse diretório. O arquivo `web.config.example` permanece como referência para revisão.
6. Crie um site IIS apontando para esse diretório.
7. Configure o binding HTTPS:
   - Type: `https`
   - IP: `All Unassigned` ou IP aprovado
   - Port: `443`
   - Host name: `whatsapp-bridge.r2pharma.com`
   - Certificado: certificado TLS correspondente ao hostname
8. Se a política exigir redirecionamento HTTP, crie também binding HTTP 80 e regra de redirecionamento para HTTPS.
9. Não configure o IIS para executar JavaScript/Node. O IIS somente encaminha para `http://127.0.0.1:3002`.

O site IIS não deve publicar listagem de diretório, arquivos `.env`, `auth`, logs ou qualquer conteúdo de sessão.

## 5. DNS e firewall

O registro DNS interno deve ser criado no DNS corporativo, não em um DNS paralelo na bridge:

```text
whatsapp-bridge.r2pharma.com  A  192.168.1.155
```

No firewall do servidor `192.168.1.155`:

- Permitir entrada TCP 443 somente das origens autorizadas, incluindo `192.168.1.154`.
- Não expor TCP 3002 na rede; o Node está preso a `127.0.0.1`.
- Permitir saída HTTPS necessária ao WhatsApp Web e aos serviços auxiliares aprovados.
- Permitir saída TCP 443 da bridge para a aplicação em `192.168.1.154`, para os eventos assinados da sessão.
- Registrar a regra, origem, destino, porta e responsável pela aprovação.

O DNS não configura portas. A aplicação usa HTTPS 443 para o hostname; o IIS encaminha internamente para 3002.

## 6. Testar saúde e integração

No servidor da bridge:

```powershell
Set-Location $InstallDir
.\deploy\iis\health-check.ps1 -PublicUrl 'https://whatsapp-bridge.r2pharma.com'
```

No servidor da aplicação `192.168.1.154`:

```powershell
Resolve-DnsName whatsapp-bridge.r2pharma.com
Test-NetConnection whatsapp-bridge.r2pharma.com -Port 443
Invoke-RestMethod https://whatsapp-bridge.r2pharma.com/healthz
```

O resultado esperado do `healthz` é `status: ok`. Para consultar o status autenticado sem colocar o token no histórico do PowerShell, use um prompt seguro ou o mecanismo de segredo aprovado; não registre o comando completo em chamado ou log.

Na configuração server-side da aplicação, cadastre:

```dotenv
WHATSAPP_SESSION_SERVICE_URL=https://whatsapp-bridge.r2pharma.com
WHATSAPP_SESSION_SERVICE_TOKEN=mesmo-token-no-cofre
```

A aplicação deve aceitar somente HTTPS e nunca deve enviar esse token ao navegador.

Para concluir a HU-001 V1.1, configure também no `.env` da bridge, por canal seguro:

```dotenv
R2PHARMA_EVENT_WEBHOOK_URL=https://customer.r2pharma.com/api/bridge/events
R2PHARMA_EVENT_WEBHOOK_SECRET=segredo-hmac-compartilhado-no-cofre
```

O segredo HMAC é **distinto** do `BRIDGE_TOKEN`. O console valida a assinatura no cabeçalho `x-r2pharma-signature`, rejeita eventos sem segredo e não aceita HTTP. Não usar a URL, o segredo ou o token em código, documentos de chamado ou logs. A bridge descobre todos os grupos; a decisão de ativar, manter pendente ou marcar um grupo como não autorizado ocorre na aplicação.

## 7. Primeiro pareamento por QR Code

1. Acesse a tela de Sessão WhatsApp na aplicação.
2. Confirme que o serviço externo está alcançável.
3. Solicite conexão e aguarde o QR Code efêmero.
4. Na conta corporativa, abra **WhatsApp → Aparelhos conectados → Conectar aparelho**.
5. Leia o QR Code na janela operacional; não faça captura nem envie o QR por chat.
6. Confirme `conectado`, nome/número somente no estado conectado, sincronização de grupos e reconexão após reinício.
7. Registre versão, hostname, data, executor e resultado do teste controlado.

## 8. Operação, atualização e recuperação

Logs do serviço ficam em:

```text
C:\ProgramData\R2PHARMA\WhatsAppBridge\logs
```

Para reiniciar:

```powershell
Restart-Service R2PHARMA-WhatsAppBridge
```

Antes de atualizar:

1. Fazer backup criptografado e aprovado de `C:\ProgramData\R2PHARMA\WhatsAppBridge\auth`.
2. Registrar versão, estado da sessão e janela de mudança.
3. Parar o serviço.
4. Extrair o novo pacote sem apagar `DataDir`.
5. Executar `npm ci --omit=dev`, `npm run check` e os testes.
6. Iniciar o serviço e validar health, ready, status, reconexão e logs.
7. Reverter o diretório da aplicação e o serviço se houver regressão; não restaurar sessão sem autorização.

A ação de desconectar remove os dados locais de autenticação e exige novo QR Code. Trate-a como operação destrutiva da sessão e mantenha-a protegida por RBAC.

## 9. Critérios de aceite

- `customer.r2pharma.com` resolve para `192.168.1.154` e `whatsapp-bridge.r2pharma.com` resolve para `192.168.1.155` no DNS interno.
- A aplicação alcança a bridge por HTTPS 443.
- TCP 3002 não está exposto na rede.
- `/healthz` responde `200` sem token e `/v1/*` bloqueia requisições sem Bearer token.
- QR Code é efêmero e não aparece em logs, arquivos ou chamados.
- Pareamento, sincronização de grupos, reconexão, reinício e desconexão foram testados em janela controlada.
- `.env`, token, certificado, chave privada e sessão ficam fora do ZIP e sob controle da R2PHARMA.
- O risco de dependências upstream foi revisado conforme `SECURITY.md`; esta distribuição não constitui aprovação automática de produção.
