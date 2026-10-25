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
      R2PHARMA_EVENT_WEBHOOK_URL: environment.R2PHARMA_EVENT_WEBHOOK_URL,
    },
    encoding: 'utf8',
  });
}

function loadWebhookTimeout(timeout) {
  const script = `import(${JSON.stringify(configPath)}).then(({ config }) => process.stdout.write(String(config.eventWebhookTimeoutMs))).catch((error) => { process.stderr.write(error.message); process.exit(1); });`;
  const env = { ...process.env, NODE_ENV: 'production', BRIDGE_TOKEN: 'development-test-token-that-is-long-enough-123456' };
  delete env.R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS;
  if (timeout !== undefined) env.R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS = String(timeout);
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
