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
const config = {
  bridgeToken: 'test-token-that-is-long-enough-123456',
  rateLimitWindowMs: 60_000,
  rateLimitMax: 60,
  allowAnyGroups: false,
  allowedGroupIds: new Set(['grupo@g.us']),
};
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
      anexos: [{ nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: 4, data_base64: 'ZmFrZQ==', legenda: 'Fernanda Lima - Administradora - Bom dia' }],
    }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    message_ids: ['message-1'],
    recebido: {
      canalGrupoId: 'grupo@g.us',
      texto: 'Fernanda Lima - Administradora - Bom dia',
      anexos: [{ nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: 4, data_base64: 'ZmFrZQ==', legenda: 'Fernanda Lima - Administradora - Bom dia' }],
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

test('envio protegido rejeita campo de anexos que não seja lista', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const response = await fetch(`${baseUrl}/v1/messages/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ canal_grupo_id: 'grupo@g.us', texto: 'Anexo malformado.', anexos: {} }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    code: 'INVALID_PAYLOAD',
    message: 'O campo de anexos deve ser uma lista.',
  });
});

test('envio protegido rejeita grupo fora da allowlist antes de delegar', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const original = manager.sendMessage;
  let delegated = false;
  manager.sendMessage = async () => {
    delegated = true;
    return { accepted: true, message_ids: ['unexpected'] };
  };
  try {
    const response = await fetch(`${baseUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'grupo-nao-autorizado@g.us', texto: 'Não enviar.' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      code: 'GROUP_NOT_ALLOWED',
      message: 'O grupo informado não está autorizado para envio.',
    });
    assert.equal(delegated, false);
  } finally {
    manager.sendMessage = original;
  }
});

test('modo wildcard aceita qualquer grupo com formato @g.us e rejeita formato inválido', async () => {
  let delegated = false;
  const wildcardManager = {
    ...manager,
    sendMessage: async payload => {
      delegated = true;
      return { accepted: true, message_ids: ['wildcard-1'], recebido: payload };
    },
  };
  const wildcardServer = http.createServer(createApp({
    manager: wildcardManager,
    config: { ...config, allowAnyGroups: true, allowedGroupIds: new Set() },
  }));
  await new Promise((resolve) => wildcardServer.listen(0, '127.0.0.1', resolve));
  const address = wildcardServer.address();
  const wildcardUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  try {
    const accepted = await fetch(`${wildcardUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'novo-grupo-qualquer@g.us', texto: 'Autorização wildcard.' }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).accepted, true);
    assert.equal(delegated, true);

    const invalid = await fetch(`${wildcardUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'chat-individual@c.us', texto: 'Não enviar.' }),
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), {
      code: 'INVALID_PAYLOAD',
      message: 'O identificador do grupo deve usar o formato técnico @g.us.',
    });
  } finally {
    await new Promise((resolve) => wildcardServer.close(resolve));
  }
});

test('envio protegido rejeita conteúdo base64, tamanho declarado e extensão incompatíveis', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const scenarios = [
    { nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: 5, data_base64: 'ZmFrZQ==', code: 'INVALID_MEDIA_ATTACHMENT' },
    { nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: 4, data_base64: 'not-base64', code: 'INVALID_MEDIA_ATTACHMENT' },
    { nome: 'foto.pdf', mime_type: 'image/png', tamanho_bytes: 4, data_base64: 'ZmFrZQ==', code: 'INVALID_MEDIA_ATTACHMENT' },
    { nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: '4', data_base64: 'ZmFrZQ==', code: 'INVALID_PAYLOAD' },
    { nome: 'foto.png', mime_type: 'image/png', tamanho_bytes: true, data_base64: 'ZmFrZQ==', code: 'INVALID_PAYLOAD' },
  ];
  for (const anexo of scenarios) {
    const response = await fetch(`${baseUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'grupo@g.us', anexos: [{ ...anexo, legenda: 'fixture' }] }),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, anexo.code);
  }
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

test('envio recusado pelo gerenciador retorna conflito controlado', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const original = manager.sendMessage;
  manager.sendMessage = async () => ({
    accepted: false,
    code: 'SEND_FAILED',
    message_ids: [],
    mensagem: 'O WhatsApp não aceitou o envio da resposta.',
  });
  try {
    const response = await fetch(`${baseUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'grupo@g.us', texto: 'Resposta de fixture.' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      accepted: false,
      code: 'SEND_FAILED',
      message_ids: [],
      mensagem: 'O WhatsApp não aceitou o envio da resposta.',
    });
  } finally {
    manager.sendMessage = original;
  }
});

test('exceção inesperada do gerenciador retorna entrega incerta sem HTTP 500 genérico', async () => {
  const headers = { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' };
  const original = manager.sendMessage;
  manager.sendMessage = async () => { throw new Error('falha interna da fixture'); };
  try {
    const response = await fetch(`${baseUrl}/v1/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canal_grupo_id: 'grupo@g.us', delivery_id: 'ticket-resposta:erro-interno', texto: 'Resposta de fixture.' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      accepted: false,
      code: 'DELIVERY_UNCERTAIN',
      message_ids: [],
      mensagem: 'A tentativa de envio não pôde ser concluída com segurança. A entrega foi marcada como incerta; não repita automaticamente.',
    });
  } finally {
    manager.sendMessage = original;
  }
});
