import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import whatsappWeb from 'whatsapp-web.js';
import { logger } from './logger.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;
const SESSION_ID = 'principal';
export const INDIVIDUAL_CHAT_RESPONSE = 'Número disponível apenas para atendimento via grupo. Por favor, encaminhe sua mensagem no grupo correspondente. Obrigado!';

export function reconnectDelay(baseMs, maxMs, consecutiveFailures) {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
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

    this.#clearStaleBrowserLocks();
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

  /**
   * O perfil do Chromium fica no disco persistente. Se a instância anterior foi encerrada sem fechar
   * o navegador (OOM, deploy, reinício), os arquivos Singleton* continuam lá apontando para outro
   * host, e o Chromium se recusa a abrir o perfil ("profile appears to be in use ... on another
   * computer"). A bridge roda sempre com uma única instância, então é seguro removê-los antes de iniciar.
   */
  #clearStaleBrowserLocks() {
    const profileDir = path.join(this.config.authPath, `session-${this.config.clientId}`);
    const removed = [];
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        unlinkSync(path.join(profileDir, name));
        removed.push(name);
      } catch (error) {
        if (error?.code !== 'ENOENT') logger.warn('browser_lock_cleanup_failed', { session_id: SESSION_ID, file: name, code: error?.code });
      }
    }
    if (removed.length) logger.info('browser_stale_locks_removed', { session_id: SESSION_ID, files: removed });
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
    if (message.hasMedia && typeof message.downloadMedia === 'function') {
      const media = await message.downloadMedia();
      if (media?.mimetype) {
        attachments.push({
          nome: String(media.filename || `anexo-${attachments.length + 1}`).slice(0, 240),
          mime_type: String(media.mimetype).slice(0, 120),
          tamanho_bytes: Buffer.byteLength(String(media.data || ''), 'base64'),
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

  async #loadDeliveryLedger() {
    try {
      const raw = await fs.readFile(this.#deliveryLedgerPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entregas && typeof parsed.entregas === 'object') {
        for (const [key, value] of Object.entries(parsed.entregas)) {
          if (typeof key === 'string' && value && typeof value === 'object' && typeof value.fingerprint === 'string' && Array.isArray(value.message_ids)) {
            this.deliveryLedger.set(key, {
              fingerprint: value.fingerprint,
              message_ids: value.message_ids.filter((id) => typeof id === 'string').slice(0, 20),
              recorded_at: typeof value.recorded_at === 'string' ? value.recorded_at : new Date().toISOString(),
            });
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('whatsapp_delivery_ledger_read_warning', { error: safeError(error) });
    }
  }

  #deliveryFingerprint({ canalGrupoId, texto, anexos, quotedMessageId }) {
    return createHash('sha256').update(JSON.stringify({ canalGrupoId, texto, anexos, quotedMessageId })).digest('hex');
  }

  async #persistDelivery(deliveryId, value) {
    this.deliveryLedger.set(deliveryId, value);
    this.deliveryLedgerWrite = this.deliveryLedgerWrite.then(async () => {
      const ledgerPath = this.#deliveryLedgerPath();
      await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
      const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify({ atualizado_em: new Date().toISOString(), entregas: Object.fromEntries(this.deliveryLedger) }, null, 2), { mode: 0o600 });
      await fs.rename(temporaryPath, ledgerPath);
    }).catch((error) => {
      logger.error('whatsapp_delivery_ledger_write_failure', { error: safeError(error) });
    });
    await this.deliveryLedgerWrite;
  }

  async #sendMessageOnce({ canalGrupoId, texto = '', anexos = [], quotedMessageId = '' }) {
    if (!this.client || this.state.status !== 'conectado') {
      return { accepted: false, message_ids: [], mensagem: 'O envio exige uma sessão WhatsApp conectada.' };
    }
    const messageIds = [];
    if (texto.trim()) {
      const message = await this.client.sendMessage(canalGrupoId, texto, quotedMessageId ? { quotedMessageId } : {});
      if (message?.id?._serialized) messageIds.push(String(message.id._serialized));
    }
    for (const attachment of anexos) {
      const media = new MessageMedia(attachment.mime_type, attachment.data_base64, attachment.nome);
      const message = await this.client.sendMessage(canalGrupoId, media, { caption: attachment.legenda, ...(quotedMessageId ? { quotedMessageId } : {}) });
      if (message?.id?._serialized) messageIds.push(String(message.id._serialized));
    }
    await this.#emitEvent('message_sent', { group_id: canalGrupoId, messages_count: messageIds.length, attachments_count: anexos.length });
    logger.info('whatsapp_message_sent', { session_id: SESSION_ID, messages_count: messageIds.length, attachments_count: anexos.length });
    return { accepted: true, message_ids: messageIds, mensagem: 'Mensagem enviada ao grupo.' };
  }

  async sendMessage({ canalGrupoId, texto = '', anexos = [], quotedMessageId = '', deliveryId = '' }) {
    if (!deliveryId) return this.#sendMessageOnce({ canalGrupoId, texto, anexos, quotedMessageId });
    await this.deliveryLedgerReady;
    const fingerprint = this.#deliveryFingerprint({ canalGrupoId, texto, anexos, quotedMessageId });
    const stored = this.deliveryLedger.get(deliveryId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) return { accepted: false, code: 'DELIVERY_KEY_CONFLICT', message_ids: [], mensagem: 'A chave de entrega já foi usada com outro conteúdo.' };
      return { accepted: true, message_ids: [...stored.message_ids], mensagem: 'Entrega já confirmada anteriormente.' };
    }
    const active = this.deliveryInFlight.get(deliveryId);
    if (active) return active.fingerprint === fingerprint ? active.promise : { accepted: false, code: 'DELIVERY_KEY_CONFLICT', message_ids: [], mensagem: 'A chave de entrega já está em uso com outro conteúdo.' };
    const promise = this.#sendMessageOnce({ canalGrupoId, texto, anexos, quotedMessageId }).then(async (result) => {
      if (result.accepted) {
        await this.#persistDelivery(deliveryId, { fingerprint, message_ids: result.message_ids || [], recorded_at: new Date().toISOString() });
      }
      return result;
    });
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
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(this.config.eventWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-r2pharma-signature': signature }, body, signal: controller.signal });
    } catch (error) {
      logger.warn('event_webhook_failed', { type, error: safeError(error) });
    } finally {
      clearTimeout(timeout);
    }
  }
}
