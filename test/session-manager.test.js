import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionManager, normalizeMediaFileName, reconnectDelay } from '../src/session-manager.js';

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
        data_base64: 'ZmFrZQ==',
        legenda: 'Fernanda Lima - Administradora - Bom dia',
      }],
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.message_ids, ['message-1', 'message-2']);
    assert.equal(sent[0].message, 'Fernanda Lima - Administradora - Bom dia');
    assert.equal(sent[1].message.mimetype, 'image/png');
    assert.equal(sent[1].options.caption, 'Fernanda Lima - Administradora - Bom dia');
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
      tamanho_bytes: Buffer.byteLength('not-base64', 'base64'),
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
