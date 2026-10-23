import process from 'node:process';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = levels[process.env.LOG_LEVEL || 'info'] ?? levels.info;

function write(level, event, details = {}) {
  if (levels[level] > configuredLevel) return;
  const payload = { ts: new Date().toISOString(), level, event, ...details };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export const logger = Object.freeze({
  error: (event, details) => write('error', event, details),
  warn: (event, details) => write('warn', event, details),
  info: (event, details) => write('info', event, details),
  debug: (event, details) => write('debug', event, details),
});
