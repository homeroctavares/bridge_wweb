import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { logger } from './logger.js';

function tokenMatches(received, expected) {
  const left = Buffer.from(received || '');
  const right = Buffer.from(expected || '');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function bearerToken(req) {
  const value = req.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function createApp({ manager, config }) {
  const app = express();
  app.disable('x-powered-by');
  // Atrás de proxy (Render), confia no X-Forwarded-For para o rate limit identificar o cliente real.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '150mb', strict: true }));
  app.use(rateLimit({ windowMs: config.rateLimitWindowMs, limit: config.rateLimitMax, standardHeaders: 'draft-7', legacyHeaders: false, skip: (req) => req.path === '/healthz' || req.path === '/readyz' }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => logger.info('http_request', { method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - started }));
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'r2pharma-whatsapp-bridge' }));
  app.get('/readyz', (_req, res) => res.json({ status: 'ok', session_status: manager.status().status }));

  app.use('/v1', (req, res, next) => {
    if (!tokenMatches(bearerToken(req), config.bridgeToken)) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token de serviço ausente ou inválido.' });
      return;
    }
    next();
  });

  app.get('/v1/session/status', (_req, res) => res.json(manager.status()));
  app.get('/v1/session/qrcode', (_req, res) => res.json(manager.qrcode()));
  app.post('/v1/session/conectar', async (_req, res, next) => {
    try {
      const result = await manager.requestConnect();
      res.status(result.accepted === false ? 409 : 202).json(result);
    } catch (error) { next(error); }
  });
  app.post('/v1/session/sincronizar', async (_req, res, next) => {
    try {
      const result = await manager.syncGroups();
      res.status(result.accepted === false ? 409 : 200).json(result);
    } catch (error) { next(error); }
  });
  app.post('/v1/session/reiniciar', async (_req, res, next) => {
    try {
      const result = await manager.requestRestart();
      res.status(result.accepted === false ? 409 : 202).json(result);
    } catch (error) { next(error); }
  });
  app.post('/v1/session/desconectar', async (_req, res, next) => {
    try {
      const result = await manager.disconnect();
      res.status(result.accepted === false ? 409 : 202).json(result);
    } catch (error) { next(error); }
  });
  app.post('/v1/messages/send', async (req, res, next) => {
    try {
      const payload = req.body || {};
      if (typeof payload.canal_grupo_id !== 'string' || !payload.canal_grupo_id.trim()) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'O identificador do grupo é obrigatório.' });
        return;
      }
      if (typeof payload.delivery_id !== 'undefined' && (typeof payload.delivery_id !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(payload.delivery_id))) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'O identificador de entrega é inválido.' });
        return;
      }
      const attachments = Array.isArray(payload.anexos) ? payload.anexos : [];
      if (typeof payload.texto !== 'undefined' && typeof payload.texto !== 'string') {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'O texto da mensagem é inválido.' });
        return;
      }
      if (!payload.texto?.trim() && attachments.length === 0) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'Informe texto ou ao menos um anexo.' });
        return;
      }
      if (attachments.some((attachment) => !attachment || typeof attachment.nome !== 'string' || typeof attachment.mime_type !== 'string' || typeof attachment.data_base64 !== 'string' || typeof attachment.legenda !== 'string')) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'Um ou mais anexos são inválidos.' });
        return;
      }
      const result = await manager.sendMessage({
        canalGrupoId: payload.canal_grupo_id.trim(),
        ...(payload.delivery_id ? { deliveryId: payload.delivery_id } : {}),
        texto: payload.texto || '',
        anexos: attachments,
        ...(typeof payload.quoted_message_id === 'string' && payload.quoted_message_id.trim()
          ? { quotedMessageId: payload.quoted_message_id.trim() }
          : {}),
      });
      res.status(result.accepted === false ? 409 : 202).json(result);
    } catch (error) { next(error); }
  });

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Rota não encontrada.' }));
  app.use((error, _req, res, _next) => {
    logger.error('http_unhandled_error', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno do serviço de sessão.' });
  });
  return app;
}
