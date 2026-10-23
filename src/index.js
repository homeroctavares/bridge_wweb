import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { SessionManager } from './session-manager.js';
import { createApp } from './server.js';

const manager = new SessionManager(config);
const app = createApp({ manager, config });
const server = http.createServer(app);

server.listen(config.port, config.host, () => {
  logger.info('bridge_started', { host: config.host, port: config.port, auth_path: config.authPath, client_id: config.clientId });
  void manager.start();
});

async function shutdown(signal) {
  logger.info('bridge_shutdown_requested', { signal });
  await manager.shutdown();
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
