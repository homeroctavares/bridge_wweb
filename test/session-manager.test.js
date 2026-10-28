import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionManager, incomingMediaLimit, normalizeMediaFileName, outboundMessageIdDiagnostics, reconnectDelay } from '../src/session-manager.js';

const require = createRequire(import.meta.url);
const { Message } = require('whatsapp-web.js');

function testConfig(root) {
  return {
    headless: true,
    chromeExecutablePath: '',
    clientId: 'test-client',
    authPath: path.join(root, 'auth'),
    deliveryLedgerPath: path.join(root, 'delivery-ledger.json'),
    groupsPath: path.join(root, 'groups.json'),
    allowedGroupIds: new Set(),
    qrTtlSeconds: 60,
    restartBackoffMs: 1000,
    heartbeatIntervalMs: 5000,
    reconnectBackoffMs: 1000,
    reconnectMaxBackoffMs: 4000,
    eventWebhookUrl: '',
    eventWebhookSecret: '',
    clientFactory: () => ({
      on() {},
      async initialize() { throw new Error('simulated initialization failure'); },
      async destroy() {},
    }),
  };
}

test('backoff cresce progressivamente e respeita o teto', () => {
  assert.equal(reconnectDelay(1000, 4000, 1), 1000);
  assert.equal(reconnectDelay(1000, 4000, 2), 2000);
  assert.equal(reconnectDelay(1000, 4000, 3), 4000);
  assert.equal(reconnectDelay(1000, 4000, 20), 4000);
});

test('normaliza o nome de mídia sem permitir controles, caminhos ou extensão ausente', () => {
  const filename = normalizeMediaFileName('../foto\r\n', 0, 'image/jpeg');
  assert.equal(filename, '_foto.jpg');
  assert.match(filename, /^[^/\\\r\n]+\.jpg$/);
  assert.equal(normalizeMediaFileName(undefined, 0, 'audio/mpeg'), 'anexo-1.mp3');
});

test('diagnostica presença e forma do ID sem registrar o valor sensível', () => {
  assert.deepEqual(outboundMessageIdDiagnostics({ id: { _serialized: ' ', $1: 'valid-id' } }), {
    returned_message: true,
    id_object_present: true,
    serialized_type: 'string',
    serialized_nonempty: false,
    dollar_one_type: 'string',
    dollar_one_nonempty: true,
  });
  assert.deepEqual(outboundMessageIdDiagnostics(undefined), {
    returned_message: false,
    id_object_present: false,
    serialized_type: 'undefined',
    serialized_nonempty: false,
    dollar_one_type: 'undefined',
    dollar_one_nonempty: false,
  });
});

test('aplica os limites por categoria da política de mídia', () => {
  for (const mimeType of ['image/jpeg', 'image/png']) {
    assert.equal(incomingMediaLimit(mimeType), 5 * 1024 * 1024, mimeType);
  }
  for (const mimeType of ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'video/mp4', 'video/3gpp']) {
    assert.equal(incomingMediaLimit(mimeType), 16 * 1024 * 1024, mimeType);
  }
  for (const mimeType of [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
  ]) {
    assert.equal(incomingMediaLimit(mimeType), 100 * 1024 * 1024, mimeType);
  }
  assert.equal(incomingMediaLimit('application/zip'), 0);
  assert.equal(normalizeMediaFileName('relatorio', 0, 'application/pdf'), 'relatorio.pdf');
  assert.equal(normalizeMediaFileName('planilha', 1, 'application/vnd.ms-excel'), 'planilha.xls');
  assert.equal(normalizeMediaFileName('apresentacao', 2, 'application/vnd.ms-powerpoint'), 'apresentacao.ppt');
  assert.equal(normalizeMediaFileName('notas', 3, 'text/plain'), 'notas.txt');
  assert.equal(normalizeMediaFileName('arquivo.pdf', 4, 'image/jpeg'), 'arquivo.jpg');
});

test('QR expirado limpa o valor antigo e reinicia o ciclo de pareamento', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-qr-renewal-test-'));
  let initializations = 0;
  const config = testConfig(root);
  config.restartBackoffMs = 1;
  config.clientFactory = () => ({
    on() {},
    async initialize() { initializations += 1; },
    async destroy() {},
  });
  const manager = new SessionManager(config);
  manager.client = { async destroy() {} };
  manager.state.status = 'aguardando_qr';
  manager.qr = 'data:image/png;base64,old';
  manager.qrExpiresAt = Date.now() - 1;
  try {
    assert.equal(manager.qrcode().qr_data_url, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(initializations, 1);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falha de inicialização agenda reconexão automática e desconectar cancela o ciclo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-session-test-'));
  const manager = new SessionManager(testConfig(root));
  try {
    await manager.start();
    const reconnecting = manager.status();
    assert.equal(reconnecting.status, 'reconectando');
    assert.equal(reconnecting.reconexao_ativa, true);
    assert.equal(reconnecting.falhas_consecutivas, 1);
    assert.ok(reconnecting.proxima_tentativa_em);

    const disconnected = await manager.disconnect();
    assert.equal(disconnected.accepted, true);
    const finalState = manager.status();
    assert.equal(finalState.status, 'desconectado');
    assert.equal(finalState.reconexao_ativa, false);
    assert.equal(finalState.proxima_tentativa_em, null);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falha de autenticação publica o evento específico e inicia reconexão', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-auth-failure-test-'));
  const handlers = new Map();
  const events = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  try {
    await manager.start();
    await handlers.get('auth_failure')('sessão revogada');
    assert.deepEqual(events.map((event) => event.type), ['auth_failure', 'reconnecting']);
    assert.equal(events[0].status, 'falha');
    assert.equal(events[1].status, 'reconectando');
    assert.equal(events.filter((event) => event.type === 'failure').length, 0);
    assert.equal(manager.status().status, 'reconectando');
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('aguarda o timeout configurado para webhook de documentos grandes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-webhook-timeout-test-'));
  const previousFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.eventWebhookTimeoutMs = 20;
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async getChats() { return []; },
    async destroy() {},
  };
  try {
    const result = await manager.syncGroups();
    assert.equal(result.accepted, true);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('não silencia rejeição HTTP do webhook e preserva o fluxo da bridge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-webhook-http-rejection-test-'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'corpo não deve ser registrado' });
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async getChats() { return []; },
    async destroy() {},
  };
  try {
    const result = await manager.syncGroups();
    assert.equal(result.accepted, true);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sincroniza todos os grupos e informa o total de participantes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-groups-test-'));
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async getChats() {
      return [
        { isGroup: true, id: { _serialized: 'grupo-1@g.us' }, name: 'SMN Moinhos', participants: [{}, {}, {}] },
        { isGroup: true, id: { _serialized: 'grupo-2@g.us' }, name: 'SMN Sírio', participants: undefined },
        { isGroup: false, id: { _serialized: 'contato@c.us' }, name: 'Contato externo', participants: [{}] },
      ];
    },
    async destroy() {},
  };
  try {
    const result = await manager.syncGroups();
    assert.deepEqual(result.grupos.map(({ canal_grupo_id, participantes }) => ({ canal_grupo_id, participantes })), [
      { canal_grupo_id: 'grupo-1@g.us', participantes: 3 },
      { canal_grupo_id: 'grupo-2@g.us', participantes: 0 },
    ]);

    const persisted = JSON.parse(await fs.readFile(path.join(root, 'groups.json'), 'utf8'));
    assert.equal(persisted.grupos[0].participantes, 3);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falha de sincronização gera evento operacional sem alterar o estado da sessão', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-sync-failure-test-'));
  const events = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async getChats() { throw new Error('falha simulada ao ler grupos'); },
    async destroy() {},
  };
  try {
    const result = await manager.syncGroups();
    assert.equal(result.accepted, false);
    assert.match(result.mensagem, /Falha ao sincronizar grupos/);
    assert.deepEqual(events.map((event) => event.type), ['sync_failure']);
    assert.equal(manager.status().status, 'conectado');
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('envia texto e anexo ao grupo conectado com legenda', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-test-'));
  const manager = new SessionManager(testConfig(root));
  const sent = [];
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage(chatId, message, options) {
      sent.push({ chatId, message, options });
      return { id: { _serialized: `message-${sent.length}` } };
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      texto: 'Fernanda Lima - Administradora - Bom dia',
      anexos: [{
        nome: 'foto.png',
        mime_type: 'image/png',
        tamanho_bytes: 4,
        data_base64: 'ZmFrZQ==',
        legenda: 'Fernanda Lima - Administradora - Bom dia',
      }],
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.message_ids, ['message-1', 'message-2']);
    assert.equal(sent[0].message, 'Fernanda Lima - Administradora - Bom dia');
    assert.equal(sent[0].options.waitUntilMsgSent, true);
    assert.equal(sent[1].message.mimetype, 'image/png');
    assert.equal(sent[1].options.caption, 'Fernanda Lima - Administradora - Bom dia');
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('envia documentos como documento e preserva legenda e citação', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-document-test-'));
  const sent = [];
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage(chatId, message, options) {
      sent.push({ chatId, message, options });
      return { id: { _serialized: `document-message-${sent.length}` } };
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        tamanho_bytes: Buffer.byteLength('docx-fixture'),
        data_base64: Buffer.from('docx-fixture').toString('base64'),
        legenda: 'Equipe R2PHARMA - Relatório anexado',
      }],
      quotedMessageId: 'incoming-message-1',
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.message_ids, ['document-message-1']);
    assert.equal(sent[0].message.mimetype, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(sent[0].message.filename, 'relatorio.docx');
    assert.deepEqual(sent[0].options, {
      waitUntilMsgSent: false,
      caption: 'Equipe R2PHARMA - Relatório anexado',
      sendMediaAsDocument: true,
      quotedMessageId: 'incoming-message-1',
    });
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('não transforma falha da confirmação interna de mídia em MESSAGE_ID_MISSING quando o cliente retorna ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-media-confirmation-fallback-test-'));
  const calls = [];
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage(_chatId, _message, options) {
      calls.push(options);
      if (options.waitUntilMsgSent === true) {
        throw Object.assign(new Error('Data passed to getter must include an id property'), { code: 'MESSAGE_ID_MISSING' });
      }
      return { id: { _serialized: 'media-confirmed-after-fallback' } };
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
      }],
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.message_ids, ['media-confirmed-after-fallback']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].waitUntilMsgSent, false);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('converte falha do cliente outbound em rejeição controlada sem falso sucesso', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-failure-test-'));
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { throw new Error('falha interna do processamento documental'); },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
        legenda: 'Equipe R2PHARMA - PDF anexado',
      }],
    });
    assert.deepEqual(result, {
      accepted: false,
      code: 'SEND_FAILED',
      message_ids: [],
      mensagem: 'O WhatsApp não aceitou o envio da resposta. Nenhuma confirmação de entrega foi registrada; revise o arquivo e tente novamente.',
    });
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('classifica a exceção upstream de ID ausente mesmo sem error.code explícito', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-missing-id-error-code-test-'));
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { throw new Error('Data passed to getter must include an id property'); },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
      }],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'MESSAGE_ID_MISSING');
    assert.deepEqual(result.message_ids, []);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('emite diagnóstico sanitizado da falha documental sem vazar dados sensíveis', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-failure-diagnostic-test-'));
  const events = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true, status: 202 };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() {
      throw new Error('Data passed to getter must include an id property; token=secret-value Authorization: Bearer REAL_TOKEN access_token=ANOTHER_TOKEN https://static.whatsapp.test/media/123456789 5511999999999@g.us phone=(11) 99999-9999 data:image/png;base64,QUJD ' + 'A'.repeat(96));
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
      }],
      deliveryId: 'diagnostic:document-1',
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'DELIVERY_UNCERTAIN');
    const failure = events.find(event => event.type === 'message_send_failure');
    assert.ok(failure);
    assert.equal(failure.error_code, 'MESSAGE_ID_MISSING');
    assert.equal(failure.attachments_count, 1);
    assert.equal(failure.message_ids_count, 0);
    assert.match(failure.error_message, /^WHATSAPP_WEB_MISSING_MESSAGE_ID#[a-f0-9]{16}$/);
    assert.doesNotMatch(failure.error_message, /secret-value|REAL_TOKEN|ANOTHER_TOKEN|static\.whatsapp|5511999999999|99999-9999|data:image|QUJD|A{80}/);
    assert.equal(failure.status, 'conectado');
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejeição 422 do webhook de falha não transforma o envio em erro de transporte', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-failure-webhook-rejection-test-'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422 });
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { throw new Error('document dispatch failed'); },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      texto: 'Resposta com observabilidade rejeitada.',
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'SEND_FAILED');
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('normaliza código arbitrário com mensagem genérica antes do evento outbound', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-failure-arbitrary-code-test-'));
  const events = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true, status: 202 };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() {
      throw Object.assign(new Error('generic dispatch failure'), { code: 'UNTRUSTED_INTERNAL_CODE' });
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({ canalGrupoId: 'grupo@g.us', texto: 'Resposta controlada.' });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'SEND_FAILED');
    const failure = events.find(event => event.type === 'message_send_failure');
    assert.ok(failure);
    assert.equal(failure.error_code, 'SEND_FAILED');
    assert.match(failure.error_message, /^WHATSAPP_WEB_ERROR#[a-f0-9]{16}$/);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserva IDs parciais e bloqueia nova tentativa cega após falha composta', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-partial-test-'));
  let sends = 0;
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() {
      sends += 1;
      if (sends === 1) return { id: { _serialized: 'partial-message-1' } };
      throw new Error('falha documental após primeiro efeito');
    },
    async destroy() {},
  };
  try {
    const payload = {
      canalGrupoId: 'grupo@g.us',
      texto: 'Resposta com dois efeitos.',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
        legenda: 'Resposta com dois efeitos.',
      }],
      deliveryId: 'comunicacao-parcial:destino-1',
    };
    const first = await manager.sendMessage(payload);
    assert.equal(first.accepted, false);
    assert.equal(first.code, 'DELIVERY_UNCERTAIN');
    assert.deepEqual(first.message_ids, ['partial-message-1']);
    const second = await manager.sendMessage(payload);
    assert.equal(second.accepted, false);
    assert.equal(second.code, 'DELIVERY_UNCERTAIN');
    assert.deepEqual(second.message_ids, ['partial-message-1']);
    assert.equal(sends, 2);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('não confirma envio sem identificador de mensagem', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-missing-id-test-'));
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { return {}; },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({ canalGrupoId: 'grupo@g.us', texto: 'Sem confirmação.' });
    assert.deepEqual(result, {
      accepted: false,
      code: 'MESSAGE_ID_MISSING',
      message_ids: [],
      mensagem: 'O WhatsApp não confirmou o identificador da mensagem. Nenhuma confirmação de entrega foi registrada.',
    });
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('confirma documento citado quando o WhatsApp Web retorna id.$1 e aguarda o envio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-dollar-one-id-test-'));
  const calls = [];
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage(...args) {
      calls.push(args);
      return { id: { _serialized: '   ', $1: 'media-dollar-one-id' } };
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
        legenda: 'Documento citado.',
      }],
      quotedMessageId: 'quoted-message-id',
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.message_ids, ['media-dollar-one-id']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].waitUntilMsgSent, false);
    assert.equal(calls[0][2].sendMediaAsDocument, true);
    assert.equal(calls[0][2].quotedMessageId, 'quoted-message-id');
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('aceita o Message real normalizado pelo whatsapp-web.js quando o modelo só possui $1', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-real-message-model-test-'));
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() {
      return new Message({}, {
        id: { $1: 'normalized-message-id', id: 'fixture-id', remote: 'grupo@g.us', fromMe: true },
        ack: 0,
        body: 'Documento fixture',
        type: 'document',
        t: Math.floor(Date.now() / 1000),
        from: 'conta@c.us',
        to: 'grupo@g.us',
      });
    },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      anexos: [{
        nome: 'relatorio.pdf',
        mime_type: 'application/pdf',
        tamanho_bytes: Buffer.byteLength('pdf-fixture'),
        data_base64: Buffer.from('pdf-fixture').toString('base64'),
      }],
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.message_ids, ['normalized-message-id']);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falha fechada quando o ledger de entrega está corrompido', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-ledger-corrupt-test-'));
  const config = testConfig(root);
  await fs.writeFile(config.deliveryLedgerPath, '{"entregas": []}', 'utf8');
  let sends = 0;
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { sends += 1; return { id: { _serialized: 'should-not-send' } }; },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({ canalGrupoId: 'grupo@g.us', texto: 'Ledger indisponível.', deliveryId: 'ledger-corrupt:1' });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'DELIVERY_LEDGER_UNAVAILABLE');
    assert.equal(sends, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('converte falha ao reservar o ledger em erro controlado sem tentar enviar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-ledger-reservation-failure-test-'));
  const config = testConfig(root);
  let sends = 0;
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { sends += 1; return { id: { _serialized: 'should-not-send' } }; },
    async destroy() {},
  };
  try {
    await manager.deliveryLedgerReady;
    await fs.mkdir(config.deliveryLedgerPath);
    const result = await manager.sendMessage({ canalGrupoId: 'grupo@g.us', texto: 'Reserva de ledger.', deliveryId: 'ledger-write-failure:1' });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'DELIVERY_LEDGER_UNAVAILABLE');
    assert.equal(sends, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falha fechada quando uma entrada interna do ledger possui status desconhecido', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-ledger-entry-corrupt-test-'));
  const config = testConfig(root);
  await fs.writeFile(config.deliveryLedgerPath, JSON.stringify({ entregas: {
    'ledger-corrupt-entry:1': {
      fingerprint: '0123456789abcdef0123456789abcdef',
      status: 'sent-but-not-verified',
      message_ids: ['message-1'],
      recorded_at: new Date().toISOString(),
    },
  } }), 'utf8');
  let sends = 0;
  const manager = new SessionManager(config);
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { sends += 1; return { id: { _serialized: 'should-not-send' } }; },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({ canalGrupoId: 'grupo@g.us', texto: 'Ledger inválido.', deliveryId: 'ledger-corrupt-entry:1' });
    assert.equal(result.code, 'DELIVERY_LEDGER_UNAVAILABLE');
    assert.equal(sends, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejeita chamada direta sem conteúdo antes de enviar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-empty-send-test-'));
  let sends = 0;
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage() { sends += 1; return { id: { _serialized: 'should-not-send' } }; },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({ canalGrupoId: 'grupo@g.us' });
    assert.equal(result.code, 'EMPTY_MESSAGE');
    assert.equal(result.accepted, false);
    assert.equal(sends, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('valida anexo outbound antes de enviar texto ou mídia', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-send-invalid-media-test-'));
  const sent = [];
  const manager = new SessionManager(testConfig(root));
  manager.state.status = 'conectado';
  manager.client = {
    async sendMessage(...args) { sent.push(args); return { id: { _serialized: `message-${sent.length}` } }; },
    async destroy() {},
  };
  try {
    const result = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      texto: 'Texto não deve ser enviado.',
      anexos: [{ nome: 'foto.pdf', mime_type: 'image/png', tamanho_bytes: 4, data_base64: 'ZmFrZQ==', legenda: 'fixture' }],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'INVALID_MEDIA_ATTACHMENT');
    assert.equal(sent.length, 0);
    const typeResult = await manager.sendMessage({
      canalGrupoId: 'grupo@g.us',
      texto: 'Texto não deve ser enviado.',
      anexos: [{ nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: '4', data_base64: 'ZmFrZQ==', legenda: 'fixture' }],
    });
    assert.equal(typeResult.accepted, false);
    assert.equal(typeResult.code, 'INVALID_MEDIA_ATTACHMENT');
    assert.equal(sent.length, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deduplica uma entrega estável e recupera o resultado do ledger após reinicialização', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-delivery-ledger-test-'));
  let sends = 0;
  const clientFactory = () => ({
    async sendMessage() {
      sends += 1;
      return { id: { _serialized: `delivery-message-${sends}` } };
    },
    async destroy() {},
  });
  const first = new SessionManager({ ...testConfig(root), clientFactory });
  first.state.status = 'conectado';
  first.client = { async sendMessage() { sends += 1; return { id: { _serialized: `delivery-message-${sends}` } }; }, async destroy() {} };
  try {
    const payload = { canalGrupoId: 'grupo@g.us', texto: 'Entrega idempotente.', deliveryId: 'comunicacao-1:destino-1' };
    const firstResult = await first.sendMessage(payload);
    const duplicateResult = await first.sendMessage(payload);
    assert.deepEqual(firstResult.message_ids, ['delivery-message-1']);
    assert.deepEqual(duplicateResult.message_ids, ['delivery-message-1']);
    assert.equal(sends, 1);
  } finally {
    await first.shutdown();
  }
  const second = new SessionManager({ ...testConfig(root), clientFactory });
  second.state.status = 'conectado';
  second.client = { async sendMessage() { sends += 1; return { id: { _serialized: `unexpected-${sends}` } }; }, async destroy() {} };
  try {
    const result = await second.sendMessage({ canalGrupoId: 'grupo@g.us', texto: 'Entrega idempotente.', deliveryId: 'comunicacao-1:destino-1' });
    assert.deepEqual(result.message_ids, ['delivery-message-1']);
    assert.equal(sends, 1);
  } finally {
    await second.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('compacta o ledger no carregamento por TTL e limite, preservando estados incertos', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-ledger-retention-test-'));
  const config = {
    ...testConfig(root),
    deliveryLedgerTtlSeconds: 60,
    deliveryLedgerMaxEntries: 3,
  };
  const now = Date.now();
  const entry = (status, recordedAt, messageId) => ({
    fingerprint: `${messageId}-fingerprint-0123456789`,
    status,
    message_ids: [messageId],
    recorded_at: new Date(recordedAt).toISOString(),
  });
  await fs.writeFile(config.deliveryLedgerPath, JSON.stringify({ entregas: {
    'expired-confirmed': entry('confirmed', now - 120_000, 'expired-message'),
    'oldest-confirmed': entry('confirmed', now - 50_000, 'oldest-message'),
    'newest-confirmed': entry('confirmed', now - 10_000, 'newest-message'),
    'uncertain-entry': entry('uncertain', now - 86_400_000, 'uncertain-message'),
    'in-progress-entry': entry('in_progress', now - 86_400_000, 'in-progress-message'),
  } }), 'utf8');
  const manager = new SessionManager(config);
  try {
    await manager.deliveryLedgerReady;
    const persisted = JSON.parse(await fs.readFile(config.deliveryLedgerPath, 'utf8'));
    assert.deepEqual(Object.keys(persisted.entregas), [
      'in-progress-entry',
      'newest-confirmed',
      'uncertain-entry',
    ]);
    assert.equal(persisted.entregas['uncertain-entry'].status, 'uncertain');
    assert.equal(persisted.entregas['in-progress-entry'].status, 'in_progress');

    manager.state.status = 'conectado';
    let sends = 0;
    manager.client = { async sendMessage() { sends += 1; return { id: { _serialized: 'must-not-send' } }; }, async destroy() {} };
    const payload = { canalGrupoId: 'grupo@g.us', texto: 'Não reenviar.', anexos: [], quotedMessageId: '' };
    manager.deliveryLedger.get('uncertain-entry').fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const result = await manager.sendMessage({ ...payload, deliveryId: 'uncertain-entry' });
    assert.equal(result.code, 'DELIVERY_UNCERTAIN');
    assert.equal(sends, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('limite do ledger escolhe confirmados por timestamp e usa a chave como desempate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-ledger-order-test-'));
  const config = { ...testConfig(root), deliveryLedgerTtlSeconds: 86_400, deliveryLedgerMaxEntries: 1 };
  const recordedAt = new Date(Date.now() - 1_000).toISOString();
  const entry = (key) => ({ fingerprint: `${key}-fingerprint-0123456789`, status: 'confirmed', message_ids: [`${key}-message`], recorded_at: recordedAt });
  await fs.writeFile(config.deliveryLedgerPath, JSON.stringify({ entregas: {
    'z-key': entry('z-key'),
    'a-key': entry('a-key'),
  } }), 'utf8');
  const manager = new SessionManager(config);
  try {
    await manager.deliveryLedgerReady;
    const persisted = JSON.parse(await fs.readFile(config.deliveryLedgerPath, 'utf8'));
    assert.deepEqual(Object.keys(persisted.entregas), ['a-key']);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('responde automaticamente a mensagem individual e não a trata como grupo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-individual-test-'));
  const handlers = new Map();
  const replies = [];
  const config = testConfig(root);
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async sendMessage(chatId, body) {
      replies.push({ chatId, body });
      return { id: { _serialized: 'automatic-reply-1' } };
    },
    async destroy() {},
  });
  const manager = new SessionManager(config);
  try {
    await manager.start();
    manager.state.status = 'conectado';
    await handlers.get('message')({
      fromMe: false,
      from: '5511999999999@c.us',
      author: '5511999999999@c.us',
      body: 'Olá, preciso de ajuda.',
      timestamp: Math.floor(Date.now() / 1000),
      id: { _serialized: 'incoming-1' },
      async getChat() { return { isGroup: false, id: { _serialized: '5511999999999@c.us' } }; },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(replies, [{ chatId: '5511999999999@c.us', body: 'Número disponível apenas para atendimento via grupo. Por favor, encaminhe sua mensagem no grupo correspondente. Obrigado!' }]);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserva nome da agenda, citação e alteração de mensagem de grupo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-history-test-'));
  const handlers = new Map();
  const events = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  const message = {
    fromMe: false,
    from: 'grupo@g.us',
    author: '5511999999999@c.us',
    body: 'Atraso no radiofármaco.',
    timestamp: Math.floor(Date.now() / 1000),
    id: { _serialized: 'incoming-group-1' },
    hasMedia: false,
    hasQuotedMsg: true,
    async getChat() { return { isGroup: true, id: { _serialized: 'grupo@g.us' } }; },
    async getContact() { return { name: 'Dra. Marina Alves', pushname: 'Marina' }; },
    async getQuotedMessage() {
      return { id: { _serialized: 'quoted-1' }, body: 'Pedido anterior', timestamp: Math.floor(Date.now() / 1000) - 60, _data: { notifyName: 'Dr. André' } };
    },
  };
  try {
    await manager.start();
    manager.state.status = 'conectado';
    await handlers.get('message')(message);
    await handlers.get('message_edit')(message, 'Atraso atualizado no radiofármaco.');
    await new Promise(resolve => setTimeout(resolve, 10));
    const received = events.find(event => event.type === 'group_message_received');
    assert.equal(received.author_name, 'Dra. Marina Alves');
    assert.equal(received.quoted_message.message_id, 'quoted-1');
    assert.equal(received.quoted_message.body, 'Pedido anterior');
    assert.equal(events.find(event => event.type === 'group_message_changed').tratamento, 'alterada');
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('não descarta imagem quando o download da mídia falha', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2pharma-media-fallback-test-'));
  const handlers = new Map();
  const events = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  try {
    await manager.start();
    manager.state.status = 'conectado';
    await handlers.get('message')({
      fromMe: false,
      from: 'grupo@g.us',
      author: '5511999999999@c.us',
      body: '',
      type: 'image',
      hasMedia: true,
      _data: { mimetype: 'image/jpeg', filename: 'foto.jpg', size: 2048 },
      timestamp: Math.floor(Date.now() / 1000),
      id: { _serialized: 'incoming-image-download-failed' },
      async getChat() { return { isGroup: true, id: { _serialized: 'grupo@g.us' } }; },
      async downloadMedia() { throw new Error('media unavailable in WhatsApp Web'); },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const received = events.find(event => event.type === 'group_message_received');
    assert.equal(received.group_id, 'grupo@g.us');
    assert.deepEqual(received.attachments, [{ nome: 'foto.jpg', mime_type: 'image/jpeg', tamanho_bytes: 2048 }]);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserva metadata-only sem tamanho quando o WhatsApp não fornece bytes nem tamanho', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2bridge-incoming-media-unknown-size-'));
  const previousFetch = globalThis.fetch;
  const handlers = new Map();
  const events = [];
  globalThis.fetch = async (_url, init) => { events.push(JSON.parse(init.body)); return { ok: true }; };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  try {
    await manager.start();
    manager.state.status = 'conectado';
    await handlers.get('message')({
      fromMe: false,
      from: 'grupo@g.us',
      author: '5511999999999@c.us',
      body: '',
      type: 'image',
      hasMedia: true,
      _data: { mimetype: 'image/jpeg', filename: 'foto.jpg' },
      timestamp: Math.floor(Date.now() / 1000),
      id: { _serialized: 'incoming-image-unknown-size' },
      async getChat() { return { isGroup: true, id: { _serialized: 'grupo@g.us' } }; },
      async downloadMedia() { throw new Error('media unavailable in WhatsApp Web'); },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const received = events.find(event => event.type === 'group_message_received');
    assert.deepEqual(received.attachments, [{ nome: 'foto.jpg', mime_type: 'image/jpeg' }]);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('encaminha imagem recebida dentro do limite com conteúdo base64 para persistência segura', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2bridge-incoming-media-ok-'));
  const previousFetch = globalThis.fetch;
  const handlers = new Map();
  const events = [];
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  const data = Buffer.from('imagem-de-fixture').toString('base64');
  try {
    await manager.start();
    manager.state.status = 'conectado';
    await handlers.get('message')({
      fromMe: false,
      from: 'grupo@g.us',
      author: '5511999999999@c.us',
      body: '',
      type: 'image',
      hasMedia: true,
      timestamp: Math.floor(Date.now() / 1000),
      id: { _serialized: 'incoming-image-download-ok' },
      async getChat() { return { isGroup: true, id: { _serialized: 'grupo@g.us' } }; },
      async downloadMedia() { return { mimetype: 'image/jpeg', data }; },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const received = events.find(event => event.type === 'group_message_received');
    assert.deepEqual(received.attachments, [{
      nome: 'anexo-1.jpg',
      mime_type: 'image/jpeg',
      tamanho_bytes: Buffer.byteLength(data, 'base64'),
      data_base64: data,
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('encaminha documentos permitidos com conteúdo base64', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2bridge-incoming-documents-ok-'));
  const previousFetch = globalThis.fetch;
  const handlers = new Map();
  const events = [];
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  const fixtures = [
    { mime: 'application/pdf', name: 'relatorio.pdf' },
    { mime: 'application/msword', name: 'contrato.doc' },
    { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'contrato.docx' },
    { mime: 'application/vnd.ms-excel', name: 'planilha.xls' },
    { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'planilha.xlsx' },
    { mime: 'application/vnd.ms-powerpoint', name: 'apresentacao.ppt' },
    { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: 'apresentacao.pptx' },
    { mime: 'text/plain', name: 'notas.txt' },
  ];
  const data = Buffer.from('document-fixture').toString('base64');
  try {
    await manager.start();
    manager.state.status = 'conectado';
    for (const [index, fixture] of fixtures.entries()) {
      await handlers.get('message')({
        fromMe: false,
        from: 'grupo@g.us',
        author: '5511999999999@c.us',
        body: '',
        type: 'document',
        hasMedia: true,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: `incoming-document-${index}` },
        async getChat() { return { isGroup: true, id: { _serialized: 'grupo@g.us' } }; },
        async downloadMedia() { return { mimetype: fixture.mime, filename: fixture.name, data }; },
      });
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    const received = events.filter(event => event.type === 'group_message_received');
    assert.equal(received.length, fixtures.length);
    assert.deepEqual(received.map(event => event.attachments?.[0]), fixtures.map(fixture => ({
      nome: fixture.name,
      mime_type: fixture.mime,
      tamanho_bytes: Buffer.byteLength(data, 'base64'),
      data_base64: data,
    })));
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserva metadados e omite bytes quando a mídia recebida possui base64 inválido', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2bridge-incoming-media-invalid-'));
  const previousFetch = globalThis.fetch;
  const handlers = new Map();
  const events = [];
  globalThis.fetch = async (_url, init) => {
    events.push(JSON.parse(init.body));
    return { ok: true };
  };
  const config = testConfig(root);
  config.eventWebhookUrl = 'https://console.example/events';
  config.eventWebhookSecret = 'test-event-secret';
  config.clientFactory = () => ({
    on(event, handler) { handlers.set(event, handler); },
    async initialize() {},
    async destroy() {},
  });
  const manager = new SessionManager(config);
  try {
    await manager.start();
    manager.state.status = 'conectado';
    await handlers.get('message')({
      fromMe: false,
      from: 'grupo@g.us',
      author: '5511999999999@c.us',
      body: '',
      type: 'image',
      hasMedia: true,
      timestamp: Math.floor(Date.now() / 1000),
      id: { _serialized: 'incoming-image-invalid-base64' },
      async getChat() { return { isGroup: true, id: { _serialized: 'grupo@g.us' } }; },
      async downloadMedia() { return { mimetype: 'image/jpeg', data: 'not-base64' }; },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const received = events.find(event => event.type === 'group_message_received');
    assert.deepEqual(received.attachments, [{
      nome: 'anexo-1.jpg',
      mime_type: 'image/jpeg',
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
