import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const configPath = path.resolve('src/config.js');

function loadWebhookUrl(environment) {
  const script = `import(${JSON.stringify(configPath)}).then(({ config }) => process.stdout.write(config.eventWebhookUrl)).catch((error) => { process.stderr.write(error.message); process.exit(1); });`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: environment.NODE_ENV,
      BRIDGE_TOKEN: 'development-test-token-that-is-long-enough-123456',
      WHATSAPP_ALLOWED_GROUP_IDS: 'grupo@g.us',
      R2PHARMA_EVENT_WEBHOOK_URL: environment.R2PHARMA_EVENT_WEBHOOK_URL,
    },
    encoding: 'utf8',
  });
}

function loadWebhookTimeout(timeout) {
  const script = `import(${JSON.stringify(configPath)}).then(({ config }) => process.stdout.write(String(config.eventWebhookTimeoutMs))).catch((error) => { process.stderr.write(error.message); process.exit(1); });`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    BRIDGE_TOKEN: 'development-test-token-that-is-long-enough-123456',
    WHATSAPP_ALLOWED_GROUP_IDS: 'grupo@g.us',
  };
  delete env.R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS;
  if (timeout !== undefined) env.R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS = String(timeout);
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });
}

function loadLedgerConfig({ nodeEnv = 'production', ttl, maxEntries, allowedGroupIds, allowAnyGroups } = {}) {
  const script = `import(${JSON.stringify(configPath)}).then(({ config }) => process.stdout.write(JSON.stringify({ ttl: config.deliveryLedgerTtlSeconds, maxEntries: config.deliveryLedgerMaxEntries, allowAnyGroups: config.allowAnyGroups, groups: [...config.allowedGroupIds] }))).catch((error) => { process.stderr.write(error.message); process.exit(1); });`;
  const env = {
    ...process.env,
    NODE_ENV: nodeEnv,
    BRIDGE_TOKEN: 'development-test-token-that-is-long-enough-123456',
    WHATSAPP_ALLOWED_GROUP_IDS: allowedGroupIds,
    WHATSAPP_ALLOW_ANY_GROUPS: allowAnyGroups,
  };
  delete env.WHATSAPP_DELIVERY_LEDGER_TTL_SECONDS;
  delete env.WHATSAPP_DELIVERY_LEDGER_MAX_ENTRIES;
  if (ttl !== undefined) env.WHATSAPP_DELIVERY_LEDGER_TTL_SECONDS = String(ttl);
  if (maxEntries !== undefined) env.WHATSAPP_DELIVERY_LEDGER_MAX_ENTRIES = String(maxEntries);
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });
}

test('aceita webhook HTTP local somente no desenvolvimento', () => {
  const result = loadWebhookUrl({ NODE_ENV: 'development', R2PHARMA_EVENT_WEBHOOK_URL: 'http://127.0.0.1:3000/api/bridge/events' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'http://127.0.0.1:3000/api/bridge/events');
});

test('rejeita webhook HTTP externo no desenvolvimento e qualquer HTTP em produção', () => {
  const externalDevelopment = loadWebhookUrl({ NODE_ENV: 'development', R2PHARMA_EVENT_WEBHOOK_URL: 'http://console.example/api/bridge/events' });
  assert.notEqual(externalDevelopment.status, 0);
  assert.match(externalDevelopment.stderr, /deve usar HTTPS/);

  const localProduction = loadWebhookUrl({ NODE_ENV: 'production', R2PHARMA_EVENT_WEBHOOK_URL: 'http://127.0.0.1:3000/api/bridge/events' });
  assert.notEqual(localProduction.status, 0);
  assert.match(localProduction.stderr, /deve usar HTTPS/);
});

test('usa janela longa e configurável para webhook de documentos grandes', () => {
  const defaultTimeout = loadWebhookTimeout();
  assert.equal(defaultTimeout.status, 0);
  assert.equal(defaultTimeout.stdout, '180000');

  const customTimeout = loadWebhookTimeout(90000);
  assert.equal(customTimeout.status, 0);
  assert.equal(customTimeout.stdout, '90000');

  for (const malformed of ['5000junk', '180000.9']) {
    const result = loadWebhookTimeout(malformed);
    assert.notEqual(result.status, 0, malformed);
    assert.match(result.stderr, /deve ser um número inteiro/, malformed);
  }
});

test('define defaults documentados para TTL/limite e fallback de allowlist somente no teste', () => {
  const defaults = loadLedgerConfig({ nodeEnv: 'production', allowedGroupIds: '123@g.us' });
  assert.equal(defaults.status, 0);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    ttl: 30 * 24 * 60 * 60,
    maxEntries: 10_000,
    allowAnyGroups: false,
    groups: ['123@g.us'],
  });

  const testFallback = loadLedgerConfig({ nodeEnv: 'test' });
  assert.equal(testFallback.status, 0);
  assert.deepEqual(JSON.parse(testFallback.stdout).groups, ['grupo@g.us']);
});

test('permite produção sem CSV somente com wildcard explícito e valida o booleano', () => {
  const wildcard = loadLedgerConfig({ nodeEnv: 'production', allowAnyGroups: 'true' });
  assert.equal(wildcard.status, 0);
  assert.deepEqual(JSON.parse(wildcard.stdout), {
    ttl: 30 * 24 * 60 * 60,
    maxEntries: 10_000,
    allowAnyGroups: true,
    groups: [],
  });

  for (const invalid of ['1', 'yes', 'TRUE', 'False']) {
    const result = loadLedgerConfig({ nodeEnv: 'production', allowAnyGroups: invalid });
    assert.notEqual(result.status, 0, invalid);
    assert.match(result.stderr, /WHATSAPP_ALLOW_ANY_GROUPS deve ser true ou false/);
  }
});

test('exige allowlist em produção sem wildcard e rejeita CSV ambíguo ou identificadores inválidos', () => {
  const missing = loadLedgerConfig({ nodeEnv: 'production' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /WHATSAPP_ALLOWED_GROUP_IDS é obrigatório.*WHATSAPP_ALLOW_ANY_GROUPS/);

  for (const allowedGroupIds of ['', '123@g.us,', '123@g.us,123@g.us', 'grupo@c.us', 'grupo@g.us;outro@g.us']) {
    const result = loadLedgerConfig({ nodeEnv: 'production', allowedGroupIds });
    assert.notEqual(result.status, 0, allowedGroupIds || '<empty>');
  }
});

test('valida TTL e limite como inteiros dentro da política', () => {
  for (const [field, value] of [['ttl', '60junk'], ['ttl', 0], ['maxEntries', '2.5'], ['maxEntries', 0]]) {
    const result = loadLedgerConfig({ nodeEnv: 'production', allowedGroupIds: '123@g.us', [field]: value });
    assert.notEqual(result.status, 0, `${field}=${value}`);
    assert.match(result.stderr, /deve ser um número inteiro/);
  }
  const custom = loadLedgerConfig({ nodeEnv: 'production', allowedGroupIds: '123@g.us,456@g.us', ttl: 60, maxEntries: 2 });
  assert.equal(custom.status, 0);
  assert.deepEqual(JSON.parse(custom.stdout), { ttl: 60, maxEntries: 2, allowAnyGroups: false, groups: ['123@g.us', '456@g.us'] });
});
