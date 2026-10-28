import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import whatsappWeb from 'whatsapp-web.js';
import { logger } from './logger.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;
const SESSION_ID = 'principal';
const DEFAULT_DELIVERY_LEDGER_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_DELIVERY_LEDGER_MAX_ENTRIES = 10_000;
const DELIVERY_STATUSES = new Set(['confirmed', 'uncertain', 'in_progress']);
export const INDIVIDUAL_CHAT_RESPONSE = 'Número disponível apenas para atendimento via grupo. Por favor, encaminhe sua mensagem no grupo correspondente. Obrigado!';

export function reconnectDelay(baseMs, maxMs, consecutiveFailures) {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function rawErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeError(error) {
  const raw = rawErrorMessage(error);
  const normalized = raw.toLowerCase();
  const category = normalized.includes('data passed to getter must include an id property') || normalized.includes('message id missing')
    ? 'WHATSAPP_WEB_MISSING_MESSAGE_ID'
    : normalized.includes('execution context was destroyed') || normalized.includes('target closed')
      ? 'WHATSAPP_WEB_CONTEXT_CLOSED'
      : normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('abort')
        ? 'WHATSAPP_WEB_TIMEOUT'
        : normalized.includes('not connected') || normalized.includes('not ready') || normalized.includes('session closed')
          ? 'WHATSAPP_WEB_NOT_READY'
          : normalized.includes('media') || normalized.includes('upload') || normalized.includes('document') || normalized.includes('sendmessage')
            ? 'WHATSAPP_WEB_MEDIA_SEND_REJECTED'
            : 'WHATSAPP_WEB_ERROR';
  const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `${category}#${fingerprint}`;
}

function outboundErrorCode(error) {
  const explicit = typeof error?.code === 'string' ? error.code : '';
  if (explicit === 'MESSAGE_ID_MISSING') return explicit;
  const normalized = rawErrorMessage(error).toLowerCase();
  if (normalized.includes('data passed to getter must include an id property') || normalized.includes('message id missing')) return 'MESSAGE_ID_MISSING';
  return 'SEND_FAILED';
}

export function outboundMessageIdDiagnostics(message) {
  const id = message?.id;
  const serialized = id?._serialized;
  const dollarOne = id?.$1;
  return {
    returned_message: Boolean(message),
    id_object_present: Boolean(id),
    serialized_type: typeof serialized,
    serialized_nonempty: typeof serialized === 'string' && Boolean(serialized.trim()),
    dollar_one_type: typeof dollarOne,
    dollar_one_nonempty: typeof dollarOne === 'string' && Boolean(dollarOne.trim()),
  };
}

function outboundMessageId(message) {
  const candidates = [message?.id?._serialized, message?.id?.$1];
  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return value ? value.trim() : '';
}

function ledgerTtlMs(runtimeConfig) {
  const seconds = Number.isSafeInteger(runtimeConfig.deliveryLedgerTtlSeconds)
    ? runtimeConfig.deliveryLedgerTtlSeconds
    : DEFAULT_DELIVERY_LEDGER_TTL_SECONDS;
  return seconds * 1000;
}

function ledgerMaxEntries(runtimeConfig) {
  return Number.isSafeInteger(runtimeConfig.deliveryLedgerMaxEntries)
    ? runtimeConfig.deliveryLedgerMaxEntries
    : DEFAULT_DELIVERY_LEDGER_MAX_ENTRIES;
}

function mediaMimeType(message) {
  const declared = message?._data?.mimetype || message?.mimetype;
  if (typeof declared === 'string' && declared.trim()) return declared.slice(0, 120);
  const byType = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/mpeg',
    document: 'application/octet-stream',
  };
  return byType[String(message?.type || '').toLowerCase()] || 'application/octet-stream';
}

const mediaFilenameExtensions = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'application/octet-stream': 'bin',
});
const mediaCompatibleExtensions = Object.freeze({
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
  'audio/aac': new Set(['.aac']),
  'audio/amr': new Set(['.amr']),
  'audio/mpeg': new Set(['.mp3']),
  'audio/mp4': new Set(['.m4a']),
  'audio/ogg': new Set(['.ogg']),
  'video/mp4': new Set(['.mp4']),
  'video/3gpp': new Set(['.3gp']),
  'application/pdf': new Set(['.pdf']),
  'application/msword': new Set(['.doc']),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': new Set(['.docx']),
  'application/vnd.ms-excel': new Set(['.xls']),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': new Set(['.xlsx']),
  'application/vnd.ms-powerpoint': new Set(['.ppt']),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': new Set(['.pptx']),
  'text/plain': new Set(['.txt']),
});

export function normalizeMediaFileName(value, index = 0, mimeType = 'application/octet-stream') {
  const fallback = `anexo-${index + 1}`;
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  let safe = raw
    .replace(/[\u0000-\u001f\u007f/\\]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 240)
    .trim() || fallback;
  const normalizedMime = String(mimeType).trim().toLowerCase();
  const existingExtension = safe.match(/\.[A-Za-z0-9]{1,8}$/)?.[0].toLowerCase();
  const compatibleExtensions = mediaCompatibleExtensions[normalizedMime];
  if (existingExtension && (!compatibleExtensions || compatibleExtensions.has(existingExtension))) return safe;
  if (existingExtension && compatibleExtensions) safe = safe.slice(0, -existingExtension.length).trim() || fallback;
  const extension = mediaFilenameExtensions[normalizedMime] || 'bin';
  const suffix = `.${extension}`;
  return `${safe.slice(0, Math.max(1, 240 - suffix.length))}${suffix}`;
}

function mediaFileName(message, index = 0) {
  const declared = message?._data?.filename || message?.filename;
  return normalizeMediaFileName(declared, index, mediaMimeType(message));
}

function mediaSizeBytes(message) {
  const value = message?._data?.size ?? message?.size;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function incomingMediaLimit(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (['image/jpeg', 'image/png'].includes(normalized)) return 5 * 1024 * 1024;
  if (['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'video/mp4', 'video/3gpp'].includes(normalized)) return 16 * 1024 * 1024;
  if ([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
  ].includes(normalized)) return 100 * 1024 * 1024;
  return 0;
}

export function validateOutgoingMediaAttachment(attachment) {
  const mimeType = typeof attachment?.mime_type === 'string' ? attachment.mime_type.trim().toLowerCase() : '';
  const fileName = typeof attachment?.nome === 'string' ? attachment.nome.trim().toLowerCase() : '';
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
  const limit = incomingMediaLimit(mimeType);
  if (!limit || !mediaCompatibleExtensions[mimeType]?.has(extension)) {
    return { valid: false, message: `O arquivo "${attachment?.nome || ''}" possui MIME ou extensão incompatível.` };
  }
  if (!isCanonicalBase64(attachment?.data_base64)) {
    return { valid: false, message: `O arquivo "${attachment.nome}" não possui conteúdo base64 válido.` };
  }
  const bytes = Buffer.from(attachment.data_base64, 'base64');
  const declaredSize = attachment?.tamanho_bytes;
  if (typeof declaredSize !== 'number' || !Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize !== bytes.length) {
    return { valid: false, message: `O tamanho declarado do arquivo "${attachment.nome}" não corresponde ao conteúdo real.` };
  }
  if (bytes.length > limit) {
    return { valid: false, message: `O arquivo "${attachment.nome}" excede o limite permitido.` };
  }
  return { valid: true, tamanho_bytes: bytes.length };
}

function shouldSendMediaAsDocument(mimeType) {
  return String(mimeType || '').trim().toLowerCase().startsWith('application/')
    || String(mimeType || '').trim().toLowerCase() === 'text/plain';
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SessionManager {
  constructor(runtimeConfig) {
    this.config = runtimeConfig;
    this.clientFactory = runtimeConfig.clientFactory || ((options) => new Client(options));
    this.client = null;
    this.startPromise = null;
    this.retryTimer = null;
    this.deliveryLedger = new Map();
    this.deliveryInFlight = new Map();
    this.deliveryLedgerWrite = Promise.resolve();
    this.deliveryLedgerError = null;
    this.deliveryLedgerReady = this.#loadDeliveryLedger();
    this.heartbeatTimer = setInterval(() => {
      this.state.ultimoHeartbeatEm = new Date().toISOString();
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    this.qr = null;
    this.qrExpiresAt = 0;
    this.manualDisconnect = false;
    this.shuttingDown = false;
    this.state = {
      status: 'desconectado',
      conectadoEm: null,
      ultimoHeartbeatEm: new Date().toISOString(),
      ultimaFalha: null,
      falhasConsecutivas: 0,
      contaNumero: null,
      contaNome: null,
      filaSaidaPendentes: 0,
      proximaTentativaEm: null,
      reconexaoAtiva: false,
    };
  }

  async start() {
    if (this.shuttingDown || this.manualDisconnect) return;
    if (this.startPromise) return this.startPromise;
    if (this.client) return;
    this.startPromise = this.#initializeClient().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #initializeClient() {
    this.state.proximaTentativaEm = null;
    if (this.state.status !== 'reconectando') this.state.status = 'desconectado';
    const puppeteer = {
      headless: this.config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };
    if (this.config.chromeExecutablePath) puppeteer.executablePath = this.config.chromeExecutablePath;

    const client = this.clientFactory({
      authStrategy: new LocalAuth({ clientId: this.config.clientId, dataPath: this.config.authPath }),
      puppeteer,
    });
    this.client = client;
    this.#bindEvents(client);
    logger.info('whatsapp_client_initializing', { session_id: SESSION_ID, client_id: this.config.clientId });

    try {
      await client.initialize();
    } catch (error) {
      await this.#fail('Falha ao inicializar o cliente WhatsApp.', error);
    }
  }

  #bindEvents(client) {
    client.on('qr', async (rawQr) => {
      try {
        this.qr = await QRCode.toDataURL(rawQr, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
        this.qrExpiresAt = Date.now() + this.config.qrTtlSeconds * 1000;
        this.state.status = 'aguardando_qr';
        this.state.reconexaoAtiva = false;
        this.state.proximaTentativaEm = null;
        this.state.ultimaFalha = null;
        await this.#emitEvent('qr_available', { expires_at: new Date(this.qrExpiresAt).toISOString() });
        logger.info('whatsapp_qr_available', { session_id: SESSION_ID, expires_in_seconds: this.config.qrTtlSeconds });
      } catch (error) {
        await this.#fail('Não foi possível gerar o QR Code.', error);
      }
    });

    client.on('authenticated', async () => {
      this.qr = null;
      this.qrExpiresAt = 0;
      this.state.status = 'pareando';
      this.state.reconexaoAtiva = false;
      this.state.proximaTentativaEm = null;
      this.state.ultimaFalha = null;
      await this.#emitEvent('authenticated');
      logger.info('whatsapp_authenticated', { session_id: SESSION_ID });
    });

    client.on('ready', async () => {
      const info = client.info;
      this.qr = null;
      this.qrExpiresAt = 0;
      this.state.status = 'conectado';
      this.state.reconexaoAtiva = false;
      this.state.proximaTentativaEm = null;
      this.state.conectadoEm = new Date().toISOString();
      this.state.ultimoHeartbeatEm = new Date().toISOString();
      this.state.ultimaFalha = null;
      this.state.falhasConsecutivas = 0;
      this.state.contaNumero = info?.wid?.user ? String(info.wid.user) : null;
      this.state.contaNome = info?.pushname ? String(info.pushname) : null;
      await this.#emitEvent('ready');
      logger.info('whatsapp_ready', { session_id: SESSION_ID, account_present: Boolean(this.state.contaNumero) });
    });

    client.on('change_state', async (state) => {
      this.state.ultimoHeartbeatEm = new Date().toISOString();
      logger.debug('whatsapp_state_changed', { session_id: SESSION_ID, state: String(state) });
    });

    client.on('disconnected', async (reason) => {
      const detail = String(reason).slice(0, 160);
      this.client = null;
      this.state.ultimoHeartbeatEm = new Date().toISOString();
      this.state.contaNumero = null;
      this.state.contaNome = null;
      this.state.ultimaFalha = `Sessão desconectada: ${detail}`;
      await this.#emitEvent('disconnected', { reason: detail });
      logger.warn('whatsapp_disconnected', { session_id: SESSION_ID, reason: detail });
      if (!this.manualDisconnect && !this.shuttingDown) this.#scheduleReconnect(this.state.ultimaFalha);
      else this.state.status = 'desconectado';
    });

    client.on('auth_failure', async (message) => {
      await this.#fail('A autenticação da sessão WhatsApp falhou.', message, 'auth_failure');
    });

    client.on('message', (message) => {
      void this.#handleIncomingMessage(message).catch((error) => {
        logger.error('whatsapp_incoming_message_failed', { session_id: SESSION_ID, error: safeError(error) });
        void this.#emitEvent('message_capture_failure', { message: safeError(error) });
      });
    });
    client.on('message_edit', (message, newBody) => {
      void this.#handleMessageChange(message, 'alterada', newBody).catch((error) => {
        logger.error('whatsapp_message_edit_failed', { session_id: SESSION_ID, error: safeError(error) });
      });
    });
    client.on('message_revoke_everyone', (message, revokedMessage) => {
      void this.#handleMessageChange(message, 'excluida', revokedMessage?.body).catch((error) => {
        logger.error('whatsapp_message_revoke_failed', { session_id: SESSION_ID, error: safeError(error) });
      });
    });
    client.on('message_revoke_me', (message) => {
      void this.#handleMessageChange(message, 'excluida').catch((error) => {
        logger.error('whatsapp_message_revoke_me_failed', { session_id: SESSION_ID, error: safeError(error) });
      });
    });
  }

  async #handleIncomingMessage(message) {
    if (!message || message.fromMe) return;
    const chat = await message.getChat();
    const messageId = String(message.id?._serialized || '');
    const occurredAt = new Date(Number(message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    let contact;
    if (typeof message.getContact === 'function') {
      try { contact = await message.getContact(); } catch { contact = undefined; }
    }
    let quotedMessage;
    if (message.hasQuotedMsg && typeof message.getQuotedMessage === 'function') {
      try {
        const quoted = await message.getQuotedMessage();
        quotedMessage = {
          message_id: String(quoted?.id?._serialized || ''),
          author_name: quoted?._data?.notifyName ? String(quoted._data.notifyName).slice(0, 240) : undefined,
          body: typeof quoted?.body === 'string' ? quoted.body.slice(0, 4000) : '',
          occurred_at: quoted?.timestamp ? new Date(Number(quoted.timestamp) * 1000).toISOString() : undefined,
        };
      } catch { quotedMessage = undefined; }
    }
    const base = {
      message_id: messageId || undefined,
      chat_id: String(message.from || chat?.id?._serialized || ''),
      author_id: String(message.author || message.from || ''),
      author_name: String(contact?.name || contact?.shortName || contact?.pushname || message._data?.notifyName || message.author || message.from || '').slice(0, 240) || undefined,
      body: typeof message.body === 'string' ? message.body.slice(0, 65536) : '',
      occurred_at: occurredAt,
      ...(quotedMessage?.message_id ? { quoted_message: quotedMessage } : {}),
    };

    if (!chat?.isGroup) {
      const automaticReply = await this.client.sendMessage(base.chat_id, INDIVIDUAL_CHAT_RESPONSE);
      await this.#emitEvent('individual_message_auto_replied', {
        ...base,
        auto_reply_message_id: automaticReply?.id?._serialized ? String(automaticReply.id._serialized) : undefined,
      });
      return;
    }

    const attachments = [];
    if (message.hasMedia) {
      let media;
      if (typeof message.downloadMedia === 'function') {
        try {
          media = await message.downloadMedia();
        } catch (error) {
          logger.warn('whatsapp_incoming_media_download_failed', {
            session_id: SESSION_ID,
            message_id_present: Boolean(messageId),
            error: safeError(error),
          });
        }
      }
      if (media?.mimetype) {
        const mimeType = String(media.mimetype).slice(0, 120);
        const dataBase64 = typeof media.data === 'string' ? media.data : '';
        const decodedSize = isCanonicalBase64(dataBase64) ? Buffer.byteLength(dataBase64, 'base64') : undefined;
        const tamanhoBytes = decodedSize ?? mediaSizeBytes(media) ?? mediaSizeBytes(message);
        const canPersist = decodedSize !== undefined && decodedSize <= incomingMediaLimit(mimeType);
        if (!canPersist) {
          logger.warn('whatsapp_incoming_media_not_forwarded', {
            session_id: SESSION_ID,
            message_id_present: Boolean(messageId),
            mime_type: mimeType,
            ...(typeof tamanhoBytes === 'number' ? { tamanho_bytes: tamanhoBytes } : {}),
            reason: dataBase64.length > 0
              ? 'invalid_base64_or_unsupported_or_exceeds_limit'
              : 'binary_unavailable',
          });
        }
        attachments.push({
          nome: normalizeMediaFileName(
            media.filename || message?._data?.filename || message?.filename,
            attachments.length,
            mimeType,
          ),
          mime_type: mimeType,
          ...(typeof tamanhoBytes === 'number' ? { tamanho_bytes: tamanhoBytes } : {}),
          ...(canPersist
            ? { data_base64: dataBase64 }
            : {}),
        });
      } else {
        // O evento não pode ser perdido apenas porque o conteúdo binário ficou
        // indisponível no WhatsApp Web. A aplicação persiste a mensagem como
        // mídia e deixa o arquivo indisponível, sem inventar bytes ou URL.
        const tamanhoBytes = mediaSizeBytes(message);
        logger.warn('whatsapp_incoming_media_not_forwarded', {
          session_id: SESSION_ID,
          message_id_present: Boolean(messageId),
          mime_type: mediaMimeType(message),
          ...(typeof tamanhoBytes === 'number' ? { tamanho_bytes: tamanhoBytes } : {}),
          reason: 'binary_unavailable',
        });
        attachments.push({
          nome: mediaFileName(message, attachments.length),
          mime_type: mediaMimeType(message),
          ...(typeof tamanhoBytes === 'number' ? { tamanho_bytes: tamanhoBytes } : {}),
        });
      }
    }
    await this.#emitEvent('group_message_received', {
      ...base,
      group_id: base.chat_id,
      attachments,
    });
  }

  async #handleMessageChange(message, treatment, previousBody) {
    if (!message || !message.id?._serialized) return;
    const chat = typeof message.getChat === 'function' ? await message.getChat() : undefined;
    if (!chat?.isGroup) return;
    await this.#emitEvent('group_message_changed', {
      message_id: String(message.id._serialized),
      group_id: String(message.from || chat.id?._serialized || ''),
      author_id: String(message.author || message.from || ''),
      body: typeof message.body === 'string' ? message.body.slice(0, 65536) : (typeof previousBody === 'string' ? previousBody.slice(0, 65536) : ''),
      tratamento: treatment,
      occurred_at: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
    });
  }

  async #fail(message, error, eventType = 'failure') {
    this.state.status = 'falha';
    this.state.reconexaoAtiva = false;
    this.state.proximaTentativaEm = null;
    this.state.ultimaFalha = message;
    this.state.falhasConsecutivas += 1;
    this.state.contaNumero = null;
    this.state.contaNome = null;
    const client = this.client;
    this.client = null;
    if (client) {
      try { await client.destroy(); } catch (destroyError) { logger.warn('whatsapp_destroy_warning', { error: safeError(destroyError) }); }
    }
    logger.error('whatsapp_client_failure', { session_id: SESSION_ID, message, error: safeError(error) });
    await this.#emitEvent(eventType, { message });
    this.#scheduleReconnect(message);
  }

  #scheduleReconnect(reason) {
    if (this.manualDisconnect || this.shuttingDown || this.retryTimer) return;
    const delay = reconnectDelay(this.config.reconnectBackoffMs, this.config.reconnectMaxBackoffMs, Math.max(1, this.state.falhasConsecutivas));
    this.state.status = 'reconectando';
    this.state.reconexaoAtiva = true;
    this.state.ultimaFalha = reason;
    this.state.proximaTentativaEm = new Date(Date.now() + delay).toISOString();
    void this.#emitEvent('reconnecting', { retry_in_ms: delay, retry_at: this.state.proximaTentativaEm });
    logger.warn('whatsapp_reconnect_scheduled', { session_id: SESSION_ID, retry_in_ms: delay, failures: this.state.falhasConsecutivas });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.state.proximaTentativaEm = null;
      void this.start();
    }, delay);
    this.retryTimer.unref?.();
  }

  #cancelReconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.state.reconexaoAtiva = false;
    this.state.proximaTentativaEm = null;
  }

  #clearExpiredQr() {
    if (this.qr && this.qrExpiresAt <= Date.now()) {
      this.qr = null;
      this.qrExpiresAt = 0;
      if (this.client && this.state.status === 'aguardando_qr' && !this.startPromise) {
        this.manualDisconnect = false;
        void this.#restart().catch((error) => void this.#fail('Falha ao renovar o QR Code expirado.', error));
      }
    }
  }

  status() {
    this.#clearExpiredQr();
    return {
      id: SESSION_ID,
      status: this.state.status,
      ...(this.state.status === 'conectado' && this.state.contaNumero ? { conta_numero: this.state.contaNumero, conta_nome: this.state.contaNome || undefined } : {}),
      conectado_em: isoOrNull(this.state.conectadoEm),
      ultimo_heartbeat_em: isoOrNull(this.state.ultimoHeartbeatEm),
      ultima_falha: this.state.ultimaFalha || undefined,
      falhas_consecutivas: this.state.falhasConsecutivas,
      fila_saida_pendentes: this.state.filaSaidaPendentes,
      proxima_tentativa_em: isoOrNull(this.state.proximaTentativaEm),
      reconexao_ativa: this.state.reconexaoAtiva,
      servico_alcancavel: true,
    };
  }

  qrcode() {
    this.#clearExpiredQr();
    return {
      qr_data_url: this.qr,
      expira_em: this.qrExpiresAt ? new Date(this.qrExpiresAt).toISOString() : null,
      mensagem: this.qr ? 'Escaneie o QR Code com a conta corporativa em WhatsApp → Aparelhos conectados.' : this.#qrMessage(),
    };
  }

  #qrMessage() {
    if (this.state.status === 'conectado') return 'A conta corporativa já está conectada.';
    if (this.state.status === 'pareando') return 'A conta foi reconhecida; aguardando a conclusão do pareamento.';
    if (this.state.status === 'reconectando') return 'A sessão perdeu a conexão e está tentando reconectar automaticamente.';
    if (this.state.status === 'falha') return this.state.ultimaFalha || 'O serviço de sessão está em falha.';
    return 'Aguardando geração do QR Code pelo serviço de sessão.';
  }

  async syncGroups() {
    if (!this.client || this.state.status !== 'conectado') {
      return { accepted: false, grupos_sincronizados: 0, grupos: [], mensagem: 'A sincronização exige uma sessão WhatsApp conectada.' };
    }
    try {
      const chats = await this.client.getChats();
      const gruposDescobertos = chats.filter((chat) => chat.isGroup).map((chat) => ({
        canal_grupo_id: String(chat.id?._serialized || chat.id?.user || ''),
        nome: String(chat.name || 'Grupo sem nome'),
        participantes: Array.isArray(chat.participants) ? chat.participants.length : 0,
        sincronizado_em: new Date().toISOString(),
      })).filter((group) => group.canal_grupo_id);
      await fs.mkdir(path.dirname(this.config.groupsPath), { recursive: true });
      await fs.writeFile(this.config.groupsPath, JSON.stringify({ atualizado_em: new Date().toISOString(), grupos: gruposDescobertos }, null, 2), { mode: 0o600 });
      await this.#emitEvent('groups_synchronized', { groups_count: gruposDescobertos.length });
      logger.info('whatsapp_groups_synchronized', { session_id: SESSION_ID, groups_count: gruposDescobertos.length });
      return { accepted: true, grupos_sincronizados: gruposDescobertos.length, grupos: gruposDescobertos, mensagem: 'Todos os grupos da conta corporativa foram sincronizados.' };
    } catch (error) {
      const message = `Falha ao sincronizar grupos: ${safeError(error)}`;
      await this.#emitEvent('sync_failure', { message });
      logger.error('whatsapp_groups_sync_failure', { session_id: SESSION_ID, error: safeError(error) });
      return { accepted: false, grupos_sincronizados: 0, grupos: [], mensagem: message };
    }
  }

  #deliveryLedgerPath() {
    return this.config.deliveryLedgerPath || path.join(path.dirname(this.config.authPath), 'delivery-ledger.json');
  }

  #pruneDeliveryLedger(now = Date.now()) {
    const ttl = ledgerTtlMs(this.config);
    const maxEntries = ledgerMaxEntries(this.config);
    const removed = { expired: 0, over_limit: 0 };

    for (const [deliveryId, entry] of this.deliveryLedger) {
      if (entry.status !== 'confirmed') continue;
      if (now - Date.parse(entry.recorded_at) >= ttl) {
        this.deliveryLedger.delete(deliveryId);
        removed.expired += 1;
      }
    }

    const protectedCount = [...this.deliveryLedger.values()].filter((entry) => entry.status !== 'confirmed').length;
    const confirmedCapacity = Math.max(0, maxEntries - protectedCount);
    const confirmed = [...this.deliveryLedger.entries()]
      .filter(([, entry]) => entry.status === 'confirmed')
      .sort(([leftId, left], [rightId, right]) => {
        const byDate = Date.parse(right.recorded_at) - Date.parse(left.recorded_at);
        if (byDate) return byDate;
        return leftId === rightId ? 0 : (leftId < rightId ? -1 : 1);
      });
    for (const [deliveryId] of confirmed.slice(confirmedCapacity)) {
      this.deliveryLedger.delete(deliveryId);
      removed.over_limit += 1;
    }

    return { ...removed, changed: removed.expired > 0 || removed.over_limit > 0 };
  }

  #serializedDeliveryLedger() {
    const entregas = Object.fromEntries([...this.deliveryLedger.entries()].sort(([left], [right]) => (
      left === right ? 0 : (left < right ? -1 : 1)
    )));
    return JSON.stringify({ atualizado_em: new Date().toISOString(), entregas }, null, 2);
  }

  async #writeDeliveryLedger() {
    const ledgerPath = this.#deliveryLedgerPath();
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporaryPath, this.#serializedDeliveryLedger(), { mode: 0o600 });
      await fs.rename(temporaryPath, ledgerPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #loadDeliveryLedger() {
    try {
      const raw = await fs.readFile(this.#deliveryLedgerPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.entregas || typeof parsed.entregas !== 'object' || Array.isArray(parsed.entregas)) {
        throw new Error('delivery ledger shape is invalid');
      }
      const loadedEntries = new Map();
      for (const [key, value] of Object.entries(parsed.entregas)) {
        if (!/^[A-Za-z0-9:_-]{1,180}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery ledger entry is invalid');
        const status = value.status;
        const messageIds = value.message_ids;
        if (typeof value.fingerprint !== 'string' || value.fingerprint.length < 16 || !DELIVERY_STATUSES.has(status) || !Array.isArray(messageIds) || messageIds.length > 20 || messageIds.some((id) => typeof id !== 'string' || id.length === 0)) {
          throw new Error('delivery ledger entry fields are invalid');
        }
        if (status === 'confirmed' && messageIds.length === 0) throw new Error('confirmed delivery has no message ids');
        const recordedAt = typeof value.recorded_at === 'string' ? Date.parse(value.recorded_at) : Number.NaN;
        if (!Number.isFinite(recordedAt)) throw new Error('delivery ledger timestamp is invalid');
        loadedEntries.set(key, {
          fingerprint: value.fingerprint,
          status,
          message_ids: [...messageIds],
          recorded_at: new Date(recordedAt).toISOString(),
        });
      }
      this.deliveryLedger = loadedEntries;
      const pruned = this.#pruneDeliveryLedger();
      if (pruned.changed) {
        await this.#writeDeliveryLedger();
        logger.info('whatsapp_delivery_ledger_compacted', {
          expired_entries: pruned.expired,
          over_limit_entries: pruned.over_limit,
          remaining_entries: this.deliveryLedger.size,
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.deliveryLedgerError = error;
        logger.warn('whatsapp_delivery_ledger_read_warning', {
          error_type: error?.constructor?.name || 'Error',
          error_code: error?.code || 'LEDGER_READ_FAILED',
        });
      }
    }
  }

  #deliveryFingerprint({ canalGrupoId, texto, anexos, quotedMessageId }) {
    return createHash('sha256').update(JSON.stringify({ canalGrupoId, texto, anexos, quotedMessageId })).digest('hex');
  }

  async #persistDelivery(deliveryId, value) {
    this.deliveryLedger.set(deliveryId, value);
    const queuedWrite = this.deliveryLedgerWrite.then(async () => {
      const pruned = this.#pruneDeliveryLedger();
      await this.#writeDeliveryLedger();
      if (pruned.changed) {
        logger.info('whatsapp_delivery_ledger_compacted', {
          expired_entries: pruned.expired,
          over_limit_entries: pruned.over_limit,
          remaining_entries: this.deliveryLedger.size,
        });
      }
    });
    this.deliveryLedgerWrite = queuedWrite.catch((error) => {
      logger.error('whatsapp_delivery_ledger_write_failure', { error_type: error?.constructor?.name || 'Error', error_code: error?.code || 'LEDGER_WRITE_FAILED' });
      return undefined;
    });
    try {
      await queuedWrite;
      this.deliveryLedgerError = null;
    } catch (error) {
      this.deliveryLedgerError = error;
      throw error;
    }
  }

  async #sendMessageOnce({ canalGrupoId, texto = '', anexos = [], quotedMessageId = '' }) {
    if (!this.client || this.state.status !== 'conectado') {
      return { accepted: false, message_ids: [], mensagem: 'O envio exige uma sessão WhatsApp conectada.' };
    }
    if (!String(texto).trim() && anexos.length === 0) {
      return { accepted: false, code: 'EMPTY_MESSAGE', message_ids: [], mensagem: 'Informe texto ou ao menos um anexo para enviar.' };
    }
    for (const attachment of anexos) {
      const validation = validateOutgoingMediaAttachment(attachment);
      if (!validation.valid) return { accepted: false, code: 'INVALID_MEDIA_ATTACHMENT', message_ids: [], mensagem: validation.message };
    }
    const messageIds = [];
    let sendPhase = 'not_started';
    try {
      if (texto.trim()) {
        sendPhase = 'calling_client_text';
        logger.info('whatsapp_message_send_started', {
          session_id: SESSION_ID,
          content_type: 'text',
          group_id_present: Boolean(canalGrupoId),
          attachments_count: anexos.length,
          quoted: Boolean(quotedMessageId),
          wait_until_msg_sent: true,
        });
        const message = await this.client.sendMessage(canalGrupoId, texto, {
          waitUntilMsgSent: true,
          ...(quotedMessageId ? { quotedMessageId } : {}),
        });
        sendPhase = 'client_returned_text';
        logger.info('whatsapp_message_send_returned', {
          session_id: SESSION_ID,
          content_type: 'text',
          ...outboundMessageIdDiagnostics(message),
        });
        const messageId = outboundMessageId(message);
        if (!messageId) {
          sendPhase = 'returned_without_id_text';
          throw Object.assign(new Error('message id missing'), { code: 'MESSAGE_ID_MISSING' });
        }
        messageIds.push(messageId);
      }
      for (const attachment of anexos) {
        const media = new MessageMedia(attachment.mime_type, attachment.data_base64, attachment.nome);
        const options = {
          waitUntilMsgSent: true,
          caption: attachment.legenda,
          ...(shouldSendMediaAsDocument(attachment.mime_type) ? { sendMediaAsDocument: true } : {}),
          ...(quotedMessageId ? { quotedMessageId } : {}),
        };
        sendPhase = 'calling_client_media';
        logger.info('whatsapp_message_send_started', {
          session_id: SESSION_ID,
          content_type: shouldSendMediaAsDocument(attachment.mime_type) ? 'document' : 'media',
          group_id_present: Boolean(canalGrupoId),
          attachments_count: anexos.length,
          quoted: Boolean(quotedMessageId),
          wait_until_msg_sent: true,
        });
        const message = await this.client.sendMessage(canalGrupoId, media, options);
        sendPhase = 'client_returned_media';
        logger.info('whatsapp_message_send_returned', {
          session_id: SESSION_ID,
          content_type: shouldSendMediaAsDocument(attachment.mime_type) ? 'document' : 'media',
          ...outboundMessageIdDiagnostics(message),
        });
        const messageId = outboundMessageId(message);
        if (!messageId) {
          sendPhase = 'returned_without_id_media';
          throw Object.assign(new Error('message id missing'), { code: 'MESSAGE_ID_MISSING' });
        }
        messageIds.push(messageId);
      }
      await this.#emitEvent('message_sent', { group_id: canalGrupoId, messages_count: messageIds.length, attachments_count: anexos.length });
      logger.info('whatsapp_message_sent', { session_id: SESSION_ID, messages_count: messageIds.length, attachments_count: anexos.length });
      return { accepted: true, message_ids: messageIds, mensagem: 'Mensagem enviada ao grupo.' };
    } catch (error) {
      logger.error('whatsapp_message_send_failure', {
        session_id: SESSION_ID,
        group_id_present: Boolean(canalGrupoId),
        attachments_count: anexos.length,
        quoted: Boolean(quotedMessageId),
        send_phase: sendPhase,
        error_type: error?.constructor?.name || 'Error',
        error_code: outboundErrorCode(error),
        error_message: safeError(error),
      });
      await this.#emitEvent('message_send_failure', {
        attachments_count: anexos.length,
        quoted: Boolean(quotedMessageId),
        message_ids_count: messageIds.length,
        error_code: outboundErrorCode(error),
        error_message: safeError(error),
      });
      return {
        accepted: false,
        code: messageIds.length > 0 ? 'DELIVERY_UNCERTAIN' : (error?.code === 'MESSAGE_ID_MISSING' ? 'MESSAGE_ID_MISSING' : 'SEND_FAILED'),
        message_ids: messageIds,
        mensagem: messageIds.length > 0
          ? 'O envio ficou parcialmente confirmado. Não repita automaticamente; reconcilie a entrega antes de tentar novamente.'
          : error?.code === 'MESSAGE_ID_MISSING'
            ? 'O WhatsApp não confirmou o identificador da mensagem. Nenhuma confirmação de entrega foi registrada.'
            : 'O WhatsApp não aceitou o envio da resposta. Nenhuma confirmação de entrega foi registrada; revise o arquivo e tente novamente.',
      };
    }
  }

  async sendMessage({ canalGrupoId, texto = '', anexos = [], quotedMessageId = '', deliveryId = '' }) {
    if (!deliveryId) return this.#sendMessageOnce({ canalGrupoId, texto, anexos, quotedMessageId });
    await this.deliveryLedgerReady;
    if (this.deliveryLedgerError) return { accepted: false, code: 'DELIVERY_LEDGER_UNAVAILABLE', message_ids: [], mensagem: 'A entrega idempotente está temporariamente indisponível; nenhuma mensagem foi enviada.' };
    const fingerprint = this.#deliveryFingerprint({ canalGrupoId, texto, anexos, quotedMessageId });
    const stored = this.deliveryLedger.get(deliveryId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) return { accepted: false, code: 'DELIVERY_KEY_CONFLICT', message_ids: [], mensagem: 'A chave de entrega já foi usada com outro conteúdo.' };
      if (stored.status === 'uncertain' || stored.status === 'in_progress') return { accepted: false, code: 'DELIVERY_UNCERTAIN', message_ids: [...stored.message_ids], mensagem: 'A entrega anterior ficou indeterminada; reconcilie a entrega antes de tentar novamente.' };
      return { accepted: true, message_ids: [...stored.message_ids], mensagem: 'Entrega já confirmada anteriormente.' };
    }
    const active = this.deliveryInFlight.get(deliveryId);
    if (active) return active.fingerprint === fingerprint ? active.promise : { accepted: false, code: 'DELIVERY_KEY_CONFLICT', message_ids: [], mensagem: 'A chave de entrega já está em uso com outro conteúdo.' };
    const promise = (async () => {
      try {
        await this.#persistDelivery(deliveryId, { fingerprint, status: 'in_progress', message_ids: [], recorded_at: new Date().toISOString() });
      } catch (error) {
        logger.error('whatsapp_delivery_reservation_failure', {
          session_id: SESSION_ID,
          error_type: error?.constructor?.name || 'Error',
          error_code: error?.code || 'DELIVERY_RESERVATION_FAILED',
        });
        return {
          accepted: false,
          code: 'DELIVERY_LEDGER_UNAVAILABLE',
          message_ids: [],
          mensagem: 'A entrega idempotente está temporariamente indisponível; nenhuma mensagem foi enviada.',
        };
      }

      let result;
      try {
        result = await this.#sendMessageOnce({ canalGrupoId, texto, anexos, quotedMessageId });
      } catch (error) {
        logger.error('whatsapp_delivery_dispatch_failure', {
          session_id: SESSION_ID,
          error_type: error?.constructor?.name || 'Error',
          error_code: error?.code || 'DELIVERY_DISPATCH_FAILED',
        });
        this.deliveryLedger.set(deliveryId, {
          fingerprint,
          status: 'uncertain',
          message_ids: [],
          recorded_at: new Date().toISOString(),
        });
        return {
          accepted: false,
          code: 'DELIVERY_UNCERTAIN',
          message_ids: [],
          mensagem: 'A tentativa de envio ficou indeterminada. Não repita automaticamente; reconcilie a entrega antes de tentar novamente.',
        };
      }
      if (result.accepted) {
        try {
          await this.#persistDelivery(deliveryId, { fingerprint, status: 'confirmed', message_ids: result.message_ids || [], recorded_at: new Date().toISOString() });
        } catch (error) {
          this.deliveryLedger.set(deliveryId, { fingerprint, status: 'uncertain', message_ids: result.message_ids || [], recorded_at: new Date().toISOString() });
          return { accepted: false, code: 'DELIVERY_UNCERTAIN', message_ids: result.message_ids || [], mensagem: 'A mensagem pode ter sido enviada, mas a confirmação idempotente não foi persistida. Não repita automaticamente.' };
        }
      } else {
        try {
          await this.#persistDelivery(deliveryId, { fingerprint, status: 'uncertain', message_ids: result.message_ids || [], recorded_at: new Date().toISOString() });
        } catch {
          this.deliveryLedger.set(deliveryId, { fingerprint, status: 'uncertain', message_ids: result.message_ids || [], recorded_at: new Date().toISOString() });
        }
        return { ...result, code: 'DELIVERY_UNCERTAIN', mensagem: result.message_ids?.length ? 'O envio ficou parcialmente confirmado. Não repita automaticamente; reconcilie a entrega antes de tentar novamente.' : 'A entrega ficou indeterminada; reconcilie a entrega antes de tentar novamente.' };
      }
      return result;
    })();
    this.deliveryInFlight.set(deliveryId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.deliveryInFlight.delete(deliveryId);
    }
  }

  async requestConnect() {
    if (this.client || this.startPromise || ['aguardando_qr', 'pareando', 'reconectando', 'conectado'].includes(this.state.status)) {
      return { accepted: false, code: 'SESSION_NOT_DISCONNECTED', mensagem: 'A conexão só pode ser solicitada quando a sessão estiver desconectada.' };
    }
    this.manualDisconnect = false;
    this.#cancelReconnect();
    if (!this.client && !this.startPromise) void this.start().catch((error) => void this.#fail('Falha ao iniciar a sessão WhatsApp.', error));
    return { accepted: true, mensagem: 'Conexão solicitada. Aguarde a geração do QR Code.' };
  }

  async requestRestart() {
    if (!['conectado', 'reconectando'].includes(this.state.status)) {
      return { accepted: false, code: 'SESSION_RESTART_REQUIRES_ACTIVE', mensagem: 'O reinício exige uma sessão conectada ou em reconexão.' };
    }
    this.manualDisconnect = false;
    this.#cancelReconnect();
    if (this.state.status === 'pareando' || this.state.status === 'conectado' || this.client) {
      void this.#restart().catch((error) => void this.#fail('Falha ao reiniciar a sessão WhatsApp.', error));
    } else {
      void this.start().catch((error) => void this.#fail('Falha ao iniciar a sessão WhatsApp.', error));
    }
    return { accepted: true, mensagem: 'Reinício da sessão solicitado.' };
  }

  async #restart() {
    const client = this.client;
    this.client = null;
    this.qr = null;
    this.qrExpiresAt = 0;
    this.state.status = 'desconectado';
    if (client) {
      try { await client.destroy(); } catch (error) { logger.warn('whatsapp_destroy_warning', { error: safeError(error) }); }
    }
    await sleep(this.config.restartBackoffMs);
    await this.start();
  }

  async disconnect() {
    if (!this.client && !this.retryTimer && this.state.status === 'desconectado') {
      return { accepted: false, code: 'SESSION_ALREADY_DISCONNECTED', mensagem: 'A sessão já está desconectada.' };
    }
    this.manualDisconnect = true;
    this.#cancelReconnect();
    const client = this.client;
    this.client = null;
    this.qr = null;
    this.qrExpiresAt = 0;
    if (client) {
      try { await client.logout(); } catch (error) { logger.warn('whatsapp_logout_warning', { error: safeError(error) }); }
      try { await client.destroy(); } catch (error) { logger.warn('whatsapp_destroy_warning', { error: safeError(error) }); }
    }
    const sessionPath = path.join(this.config.authPath, `session-${this.config.clientId}`);
    await fs.rm(sessionPath, { recursive: true, force: true });
    this.state = { ...this.state, status: 'desconectado', conectadoEm: null, contaNumero: null, contaNome: null, ultimaFalha: null, falhasConsecutivas: 0, ultimoHeartbeatEm: new Date().toISOString(), reconexaoAtiva: false, proximaTentativaEm: null };
    await this.#emitEvent('disconnected', { reason: 'logout_requested' });
    logger.info('whatsapp_session_disconnected', { session_id: SESSION_ID });
    return { accepted: true, mensagem: 'Sessão encerrada e dados de autenticação removidos da máquina.' };
  }

  async shutdown() {
    this.shuttingDown = true;
    this.manualDisconnect = true;
    this.#cancelReconnect();
    clearInterval(this.heartbeatTimer);
    const client = this.client;
    this.client = null;
    if (client) {
      try { await client.destroy(); } catch (error) { logger.warn('whatsapp_shutdown_warning', { error: safeError(error) }); }
    }
  }

  async #emitEvent(type, details = {}) {
    if (!this.config.eventWebhookUrl || !this.config.eventWebhookSecret) return;
    const body = JSON.stringify({ type, emitted_at: new Date().toISOString(), session_id: SESSION_ID, status: this.state.status, ...details });
    const signature = createHmac('sha256', this.config.eventWebhookSecret).update(body).digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.eventWebhookTimeoutMs ?? 180_000);
    try {
      const response = await fetch(this.config.eventWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-r2pharma-signature': signature }, body, signal: controller.signal });
      const responseDetails = { type, http_status: response.status };
      if (!response.ok) logger.warn('event_webhook_rejected', responseDetails);
      else logger.info('event_webhook_delivered', responseDetails);
    } catch (error) {
      logger.warn('event_webhook_failed', { type, error: safeError(error) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
