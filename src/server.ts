import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { loadEnvFile } from 'node:process';
import { loadConfig } from './auth/config.js';
import { smtpMailer } from './auth/mailer.js';
import { AuthRepository } from './auth/repository.js';
import { ResetQueue } from './auth/reset-queue.js';
import { AuthService } from './auth/service.js';
import { openRuntime } from './database/runtime.js';
import { createApp } from './http/app.js';

if (existsSync('.env')) loadEnvFile('.env');
const log = (code: string, requestId: string): void => {
  console.error(JSON.stringify({ code, requestId }));
};
try {
  const config = loadConfig(process.env);
  const proxy = process.env['TRUSTED_PROXY_IP'];
  if (proxy && !isIP(proxy)) throw new Error('TRUSTED_PROXY_IP must be one exact proxy address.');
  const database = await openRuntime(process.env);
  const repository = new AuthRepository(database);
  const queue = new ResetQueue(log);
  const auth = await AuthService.create(repository, config.auth, smtpMailer(config), queue);
  const server = createApp(auth, log, proxy).listen(config.PORT, config.HOST, () =>
    console.info('SocietyEase API ready.'),
  );
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const maintenance = setInterval(() => {
    void repository.maintenance(Date.now()).catch(() => log('MAINTENANCE_FAILED', 'system'));
  }, 60000);
  maintenance.unref();
  const shutdown = (): void => {
    clearInterval(maintenance);
    server.close(() => {
      void queue
        .idle()
        .then(() => database.pool.end())
        .catch(() => log('SHUTDOWN_FAILED', 'system'));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  log('STARTUP_FAILED', 'system');
  process.exitCode = 1;
}
