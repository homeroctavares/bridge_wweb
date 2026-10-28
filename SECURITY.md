# Segurança — R2PHARMA WhatsApp Bridge

## Estado da auditoria

Na instalação limpa desta entrega, `npm audit --omit=dev` reportou 14 vulnerabilidades transitivas: 2 moderadas e 12 altas, sem críticas, principalmente na cadeia `whatsapp-web.js@1.34.7 → puppeteer@24.38.0 → @puppeteer/browsers → extract-zip` e componentes associados. A correção automática do npm propõe uma alteração forçada de versão que não foi validada para o comportamento do WhatsApp Web; a versão atual foi mantida por decisão do owner.

Esse resultado é um **risco residual bloqueador para declarar produção aprovada**, não um item a ocultar. O cliente deve obter revisão de segurança e decidir entre aceitar temporariamente o risco com controles compensatórios ou aguardar atualização compatível do fornecedor.

## Controles compensatórios implementados

A imagem não baixa um Chromium arbitrário durante `npm install`: usa `PUPPETEER_SKIP_DOWNLOAD=true` e o Chromium instalado pelo sistema operacional da imagem. O container executa como usuário não-root, com `read_only`, `no-new-privileges`, remoção de capabilities, volume exclusivo para sessão, `/tmp` limitado e porta publicada somente em loopback. A API possui Bearer token comparado em tempo constante, limite de taxa, Helmet, payload JSON limitado e nenhuma rota pública para Chromium, banco, sessão ou QR sem autenticação.

Logs estruturados não registram token, QR Code, conteúdo de mensagens ou dados integrais da conta. O QR é mantido somente em memória e expira; a sessão persistente fica restrita ao volume `/data`.

## Condições antes da produção

O Gestor de TI e o revisor de segurança devem revisar a árvore `npm ls`, o resultado de `npm audit`, a imagem base, o proxy TLS, as regras de firewall, a política de backup do volume e os termos aplicáveis ao uso da conta WhatsApp. Devem decidir formalmente se a operação poderá iniciar com o risco upstream declarado.

Antes de aceitar a integração, executar uma varredura de imagem/container no ambiente do cliente, atualizar a imagem base e as dependências conforme versões compatíveis disponíveis, testar QR, restauração, logout e reconexão, e registrar o resultado. Não executar `npm audit fix --force` sem teste de regressão do `whatsapp-web.js`.

## Dados sensíveis

O diretório `WHATSAPP_AUTH_PATH` contém material de autenticação e deve ser tratado como segredo operacional. Não deve ser anexado a chamados, enviado ao suporte, armazenado em repositório ou exposto em compartilhamento público. Backups precisam ser criptografados, com acesso mínimo e teste de restauração isolado.
