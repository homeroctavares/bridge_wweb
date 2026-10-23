import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/server.js';

const manager = {
  status: () => ({ id: 'principal', status: 'desconectado', falhas_consecutivas: 0, fila_saida_pendentes: 0, servico_alcancavel: true }),
  qrcode: () => ({ qr_data_url: null, expira_em: null, mensagem: 'Aguardando QR Code.' }),
  requestConnect: async () => ({ accepted: true }),
  syncGroups: async () => ({ accepted: true, grupos_sincronizados: 0 }),
  requestRestart: async () => ({ accepted: true }),
  disconnect: async () => ({ accepted: true }),
  sendMessage: async payload => ({ accepted: true, message_ids: ['message-1'], recebido: payload }),
};
const config = { bridgeToken: 'test-token-that-is-long-enough-123456', rateLimitWindowMs: 60_000, rateLimitMax: 60 };
const server = http.createServer(createApp({ manager, config }));
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('health pública não exige token', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'r2pharma-whatsapp-bridge' });
});

test('rotas v1 rejeitam chamadas sem Bearer token', async () => {
  const response = await fetch(`${baseUrl}/v1/session/status`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'UNAUTHORIZED');
});

test('status e QR Code respeitam o contrato da aplicação principal', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}` };
  const status = await fetch(`${baseUrl}/v1/session/status`, { headers });
  const qrcode = await fetch(`${baseUrl}/v1/session/qrcode`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).id, 'principal');
  assert.equal(qrcode.status, 200);
  assert.equal((await qrcode.json()).qr_data_url, null);
});

test('ações protegidas delegam ao gerenciador', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}` };
  for (const action of ['conectar', 'reiniciar', 'desconectar']) {
    const response = await fetch(`${baseUrl}/v1/session/${action}`, { method: 'POST', headers });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).accepted, true);
  }
});

test('ações recusadas pelo estado da sessão retornam conflito sem falso sucesso', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}` };
  const original = manager.syncGroups;
  manager.syncGroups = async () => ({ accepted: false, code: 'SESSION_NOT_CONNECTED', mensagem: 'A sessão precisa estar conectada.' });
  try {
    const response = await fetch(`${baseUrl}/v1/session/sincronizar`, { method: 'POST', headers });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      accepted: false,
      code: 'SESSION_NOT_CONNECTED',
      mensagem: 'A sessão precisa estar conectada.',
    });
  } finally {
    manager.syncGroups = original;
  }
});

test('envio protegido valida texto/anexo e delega o payload', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const invalid = await fetch(`${baseUrl}/v1/messages/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ canal_grupo_id: 'grupo@g.us' }),
  });
  assert.equal(invalid.status, 422);

  const response = await fetch(`${baseUrl}/v1/messages/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      canal_grupo_id: 'grupo@g.us',
      texto: 'Fernanda Lima - Administradora - Bom dia',
      anexos: [{ nome: 'foto.png', mime_type: 'image/png', data_base64: 'ZmFrZQ==', legenda: 'Fernanda Lima - Administradora - Bom dia' }],
    }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    message_ids: ['message-1'],
    recebido: {
      canalGrupoId: 'grupo@g.us',
      texto: 'Fernanda Lima - Administradora - Bom dia',
      anexos: [{ nome: 'foto.png', mime_type: 'image/png', data_base64: 'ZmFrZQ==', legenda: 'Fernanda Lima - Administradora - Bom dia' }],
    },
  });

  const quoted = await fetch(`${baseUrl}/v1/messages/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ canal_grupo_id: 'grupo@g.us', texto: 'Retorno ao ponto citado.', quoted_message_id: 'incoming-001' }),
  });
  assert.equal(quoted.status, 202);
  assert.equal((await quoted.json()).recebido.quotedMessageId, 'incoming-001');
});

test('envio protegido encaminha a chave estável de entrega', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const original = manager.sendMessage;
  manager.sendMessage = async payload => ({ accepted: true, message_ids: ['stable-1'], recebido: payload });
  try {
    const response = await fetch(`${baseUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'grupo@g.us', delivery_id: 'comunicacao-1:destino-1', texto: 'Entrega estável.' }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).recebido.deliveryId, 'comunicacao-1:destino-1');
  } finally {
    manager.sendMessage = original;
  }
});
