# Distribuição Windows/IIS

Para instalar a R2PHARMA WhatsApp Bridge no servidor `192.168.1.155` com IIS, siga:

1. `deploy/iis/README.md` — procedimento completo.
2. `deploy/iis/.env.windows.example` — modelo sem segredos.
3. `deploy/iis/web.config.example` — proxy reverso IIS/ARR.
4. `MANIFEST-IIS.md` — conteúdo e exclusões do pacote.
5. `SECURITY.md` — revisão de risco upstream e condições antes da produção.

A arquitetura esperada é:

```text
Aplicação R2PHARMA 192.168.1.154
          |
          | HTTPS 443 / whatsapp-bridge.r2pharma.com
          v
IIS + ARR 192.168.1.155
          |
          | loopback HTTP 127.0.0.1:3002
          v
Node.js + whatsapp-web.js como serviço Windows
```

O ZIP não contém segredos, QR Code, sessão WhatsApp, certificados, NSSM, Node.js, Chrome ou `node_modules`. Esses componentes devem ser instalados/configurados pela equipe da R2PHARMA no servidor cliente.
