import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { logger } from './logger.js';
import { validateOutgoingMediaAttachment } from './session-manager.js';

const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}@g\.us$/;

function isValidGroupId(value) {
  return typeof value === 'string' && GROUP_ID_PATTERN.test(value);
}

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
      const canalGrupoId = payload.canal_grupo_id.trim();
      if (!isValidGroupId(canalGrupoId)) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'O identificador do grupo deve usar o formato técnico @g.us.' });
        return;
      }
      if (!config.allowAnyGroups && (!(config.allowedGroupIds instanceof Set) || !config.allowedGroupIds.has(canalGrupoId))) {
        res.status(403).json({ code: 'GROUP_NOT_ALLOWED', message: 'O grupo informado não está autorizado para envio.' });
        return;
      }
      if (typeof payload.delivery_id !== 'undefined' && (typeof payload.delivery_id !== 'string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(payload.delivery_id))) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'O identificador de entrega é inválido.' });
        return;
      }
      if (typeof payload.anexos !== 'undefined' && !Array.isArray(payload.anexos)) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'O campo de anexos deve ser uma lista.' });
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
      if (attachments.some((attachment) => !attachment || typeof attachment.nome !== 'string' || typeof attachment.mime_type !== 'string' || typeof attachment.tamanho_bytes !== 'number' || !Number.isSafeInteger(attachment.tamanho_bytes) || attachment.tamanho_bytes <= 0 || typeof attachment.data_base64 !== 'string' || typeof attachment.legenda !== 'string')) {
        res.status(422).json({ code: 'INVALID_PAYLOAD', message: 'Um ou mais anexos são inválidos.' });
        return;
      }
      for (const attachment of attachments) {
        const validation = validateOutgoingMediaAttachment(attachment);
        if (!validation.valid) {
          res.status(422).json({ code: 'INVALID_MEDIA_ATTACHMENT', message: validation.message });
          return;
        }
      }
      const result = await manager.sendMessage({
        canalGrupoId,
        ...(payload.delivery_id ? { deliveryId: payload.delivery_id } : {}),
        texto: payload.texto || '',
        anexos: attachments,
        ...(typeof payload.quoted_message_id === 'string' && payload.quoted_message_id.trim()
          ? { quotedMessageId: payload.quoted_message_id.trim() }
          : {}),
      });
      res.status(result.accepted === false ? 409 : 202).json(result);
    } catch (error) {
      logger.error('whatsapp_message_send_unhandled_error', {
        error_type: error?.constructor?.name || 'Error',
        error_code: error?.code || 'SEND_UNHANDLED_ERROR',
      });
      res.status(409).json({
        accepted: false,
        code: 'DELIVERY_UNCERTAIN',
        message_ids: [],
        mensagem: 'A tentativa de envio não pôde ser concluída com segurança. A entrega foi marcada como incerta; não repita automaticamente.',
      });
    }
  });

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Rota não encontrada.' }));
  app.use((error, _req, res, _next) => {
    logger.error('http_unhandled_error', { error_type: error?.constructor?.name || 'Error', error_code: error?.code || 'INTERNAL_ERROR' });
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno do serviço de sessão.' });
  });
  return app;
}
