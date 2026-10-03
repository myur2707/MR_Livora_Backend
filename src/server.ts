import { PropertyAccess } from './property/access.js';
import { PropertyService } from './property/service.js';
import { OccupancyService } from './property/occupancies.js';
import { ImportService } from './property/imports/service.js';
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
import { OnboardingRepository } from './onboarding/repository.js';
import { OnboardingService } from './onboarding/service.js';
import { InvitationService } from './onboarding/invitations.js';
import { ResidentAccounts } from './resident-access/accounts.js';
import { ResidentIdentity } from './resident-access/identity.js';
import { ResidentInvitations } from './resident-access/invitations.js';
import { ResidentRequests } from './resident-access/requests.js';
import { BillingAccess } from './billing/access.js';
import { billingModule } from './billing/router.js';
import { paymentModule } from './payments/router.js';
import { ResidentAccess } from './resident-portal/access.js';
import { residentPortalModule } from './resident-portal/router.js';
import { CommunityAccess } from './community/access.js';
import { communityModule } from './community/router.js';
import { reportsModule } from './reports/router.js';

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
  const mailer = smtpMailer(config);
  const auth = await AuthService.create(repository, config.auth, mailer, queue);
  const service = new OnboardingService(new OnboardingRepository(database));
  const invitationQueue = new ResetQueue((code, id) =>
    log(code.replace('RESET_', 'INVITATION_'), id),
  );
  const invitations = new InvitationService(
    service,
    config.APP_ORIGIN,
    { send: (email, link, name) => mailer.sendInvitation(email, link, name) },
    invitationQueue,
  );
  const property = new PropertyService(new PropertyAccess(database));
  const occupancy = new OccupancyService(property);
  const imports = new ImportService(property, occupancy);
  const residentQueue = new ResetQueue((code, id) => log(code.replace('RESET_', 'RESIDENT_'), id));
  const accounts = new ResidentAccounts(auth, config.APP_ORIGIN, mailer, residentQueue);
  const residentIdentity = new ResidentIdentity(property);
  const residentAccess = {
    accounts,
    invitations: new ResidentInvitations(residentIdentity, accounts),
    requests: new ResidentRequests(residentIdentity, occupancy),
  };
  const server = createApp(
    auth,
    log,
    proxy,
    { service, invitations },
    { service: property, occupancy, imports },
    residentAccess,
    billingModule(new BillingAccess(database)),
    paymentModule(new BillingAccess(database)),
    residentPortalModule(new ResidentAccess(database)),
    communityModule(new CommunityAccess(database)),
    reportsModule(new CommunityAccess(database)),
  ).listen(config.PORT, config.HOST, () => console.info('SocietyEase API ready.'));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const maintenance = setInterval(() => {
    void Promise.all([
      repository.maintenance(Date.now()),
      imports.expire(),
      accounts.expire(),
      residentAccess.invitations.expire(),
    ]).catch(() => log('MAINTENANCE_FAILED', 'system'));
  }, 60000);
  maintenance.unref();
  const shutdown = (): void => {
    clearInterval(maintenance);
    server.close(() => {
      void Promise.all([queue.idle(), invitationQueue.idle(), residentQueue.idle()])
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
