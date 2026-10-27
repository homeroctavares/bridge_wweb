import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

const DEFAULT_DELIVERY_LEDGER_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_DELIVERY_LEDGER_MAX_ENTRIES = 10_000;
const TEST_ALLOWED_GROUP_IDS = Object.freeze(['grupo@g.us']);
const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}@g\.us$/;

function integerEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} deve ser um número inteiro entre ${min} e ${max}.`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve ser um número inteiro entre ${min} e ${max}.`);
  }
  return value;
}

export function parseAllowAnyGroups(environment = process.env) {
  const raw = environment.WHATSAPP_ALLOW_ANY_GROUPS?.trim() ?? '';
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('WHATSAPP_ALLOW_ANY_GROUPS deve ser true ou false.');
}

export function parseAllowedGroupIds(environment = process.env) {
  const nodeEnv = environment.NODE_ENV || 'production';
  const raw = environment.WHATSAPP_ALLOWED_GROUP_IDS?.trim() ?? '';
  const allowAnyGroups = parseAllowAnyGroups(environment);
  if (!raw) {
    if (nodeEnv === 'test') return new Set(TEST_ALLOWED_GROUP_IDS);
    if (allowAnyGroups) return new Set();
    if (nodeEnv === 'production') {
      throw new Error('WHATSAPP_ALLOWED_GROUP_IDS é obrigatório em produção e deve conter ao menos um grupo quando WHATSAPP_ALLOW_ANY_GROUPS não está ativo.');
    }
    return new Set();
  }

  const values = raw.split(',').map((value) => value.trim());
  if (values.some((value) => !value)) {
    throw new Error('WHATSAPP_ALLOWED_GROUP_IDS deve ser uma lista CSV sem itens vazios.');
  }
  if (values.some((value) => !GROUP_ID_PATTERN.test(value))) {
    throw new Error('WHATSAPP_ALLOWED_GROUP_IDS contém um identificador de grupo inválido.');
  }
  if (new Set(values).size !== values.length) {
    throw new Error('WHATSAPP_ALLOWED_GROUP_IDS não pode conter grupos repetidos.');
  }
  return new Set(values);
}

export function isValidGroupId(value) {
  return typeof value === 'string' && GROUP_ID_PATTERN.test(value);
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
const nodeEnv = process.env.NODE_ENV || 'production';

export const config = Object.freeze({
  nodeEnv,
  host: process.env.HOST || '127.0.0.1',
  port: integerEnv('PORT', 3002, { min: 1, max: 65535 }),
  logLevel: process.env.LOG_LEVEL || 'info',
  bridgeToken: requiredToken(),
  authPath: path.resolve(rootPath),
  deliveryLedgerPath: path.resolve(deliveryLedgerPath),
  groupsPath: path.resolve(process.env.WHATSAPP_GROUPS_PATH?.trim() || path.join(path.dirname(rootPath), 'groups.json')),
  // Entradas confirmadas expiram após 30 dias; estados incertos nunca são removidos por TTL.
  deliveryLedgerTtlSeconds: integerEnv('WHATSAPP_DELIVERY_LEDGER_TTL_SECONDS', DEFAULT_DELIVERY_LEDGER_TTL_SECONDS, { min: 1, max: 10 * 365 * 24 * 60 * 60 }),
  // O limite cobre entradas confirmadas; estados incertos permanecem como bloqueio fail-closed.
  deliveryLedgerMaxEntries: integerEnv('WHATSAPP_DELIVERY_LEDGER_MAX_ENTRIES', DEFAULT_DELIVERY_LEDGER_MAX_ENTRIES, { min: 1, max: 1_000_000 }),
  allowAnyGroups: parseAllowAnyGroups(),
  allowedGroupIds: parseAllowedGroupIds(),
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
  eventWebhookTimeoutMs: integerEnv('R2PHARMA_EVENT_WEBHOOK_TIMEOUT_MS', 180_000, { min: 5_000, max: 600_000 }),
  eventWebhookUrl: optionalUrl('R2PHARMA_EVENT_WEBHOOK_URL'),
  eventWebhookSecret: process.env.R2PHARMA_EVENT_WEBHOOK_SECRET?.trim() || '',
});
