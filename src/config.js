import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

function integerEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser um número inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function requiredToken() {
  const token = process.env.BRIDGE_TOKEN?.trim() ?? '';
  if (process.env.NODE_ENV === 'test') return token || 'test-token-that-is-long-enough-123456';
  if (token.length < 32) throw new Error('BRIDGE_TOKEN é obrigatório e deve possuir pelo menos 32 caracteres.');
  return token;
}

function isLocalDevelopmentUrl(parsed, environment = process.env) {
  return environment.NODE_ENV === 'development'
    && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

function optionalUrl(name, environment = process.env) {
  const raw = environment[name]?.trim() ?? '';
  if (!raw) return '';
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && !isLocalDevelopmentUrl(parsed, environment)) {
    throw new Error(`${name} deve usar HTTPS, exceto HTTP em loopback no desenvolvimento.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

const rootPath = process.env.WHATSAPP_AUTH_PATH?.trim() || '/data/.wwebjs_auth';
const deliveryLedgerPath = process.env.WHATSAPP_DELIVERY_LEDGER_PATH?.trim()
  || path.join(path.dirname(rootPath), 'delivery-ledger.json');

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'production',
  host: process.env.HOST || '127.0.0.1',
  port: integerEnv('PORT', 3002, { min: 1, max: 65535 }),
  logLevel: process.env.LOG_LEVEL || 'info',
  bridgeToken: requiredToken(),
  authPath: path.resolve(rootPath),
  deliveryLedgerPath: path.resolve(deliveryLedgerPath),
  groupsPath: path.resolve(process.env.WHATSAPP_GROUPS_PATH?.trim() || path.join(path.dirname(rootPath), 'groups.json')),
  clientId: process.env.WHATSAPP_CLIENT_ID?.trim() || 'r2pharma-principal',
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH?.trim() || '',
  headless: process.env.PUPPETEER_HEADLESS !== 'false',
  qrTtlSeconds: integerEnv('QR_TTL_SECONDS', 60, { min: 15, max: 300 }),
  rateLimitWindowMs: integerEnv('RATE_LIMIT_WINDOW_MS', 60_000, { min: 1_000, max: 3_600_000 }),
  rateLimitMax: integerEnv('RATE_LIMIT_MAX', 60, { min: 5, max: 10_000 }),
  restartBackoffMs: integerEnv('RESTART_BACKOFF_MS', 5_000, { min: 1_000, max: 300_000 }),
  heartbeatIntervalMs: integerEnv('HEARTBEAT_INTERVAL_MS', 15_000, { min: 5_000, max: 300_000 }),
  reconnectBackoffMs: integerEnv('RECONNECT_BACKOFF_MS', 5_000, { min: 1_000, max: 300_000 }),
  reconnectMaxBackoffMs: integerEnv('RECONNECT_MAX_BACKOFF_MS', 60_000, { min: 5_000, max: 900_000 }),
  eventWebhookUrl: optionalUrl('R2PHARMA_EVENT_WEBHOOK_URL'),
  eventWebhookSecret: process.env.R2PHARMA_EVENT_WEBHOOK_SECRET?.trim() || '',
});
