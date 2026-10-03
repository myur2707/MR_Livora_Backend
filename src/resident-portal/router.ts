import { Router } from 'express';
import type { Security } from '../http/security.js';
import type { ResidentAccess } from './access.js';
import { ResidentFlats } from './flats.js';
import { ResidentBills } from './bills.js';
import { ResidentPayments } from './payments.js';
import { ResidentCommunity } from './community.js';
import { parse, identifier, pageQuery, billQuery, complaintInput } from './contracts.js';
export function residentPortalModule(access: ResidentAccess) {
  return {
    access,
    flats: new ResidentFlats(access),
    bills: new ResidentBills(access),
    payments: new ResidentPayments(access),
    community: new ResidentCommunity(access),
  };
}
export type ResidentPortalModule = ReturnType<typeof residentPortalModule>;
export function residentPortalRouter(security: Security, module: ResidentPortalModule) {
  const router = Router();
  router.use(security.authenticated, security.tenant('society.dashboard.read'));
  router.get('/dashboard', async (r, s) =>
    s.json(
      await module.access.database.transaction(async (db) => {
        const scope = await module.access.tenant(db, security.context(r).session);
        const recent = await module.payments.history(db, scope, { page: 1, pageSize: 1 });
        return {
          societyName: scope.societyName,
          timezone: scope.timezone,
          ...(await module.bills.summary(db, scope)),
          recentPayment: recent.items[0] ?? null,
          notices: (await module.community.feed(db, scope, { page: 1, pageSize: 3 })).items,
        };
      }),
    ),
  );
  router.get('/profile', async (r, s) =>
    s.json(await module.flats.profile(security.context(r).session)),
  );
  router.get('/receipts', async (r, s) =>
    s.json(
      await module.payments.list(security.context(r).session, parse(pageQuery, r.query), true),
    ),
  );
  router.get('/flats', async (r, s) =>
    s.json(await module.flats.list(security.context(r).session, parse(pageQuery, r.query))),
  );
  router.get('/flats/:id', async (r, s) =>
    s.json(
      await module.flats.detail(security.context(r).session, parse(identifier, r.params['id'])),
    ),
  );
  router.get('/bills', async (r, s) =>
    s.json(await module.bills.list(security.context(r).session, parse(billQuery, r.query))),
  );
  router.get('/bills/:id', async (r, s) =>
    s.json(
      await module.bills.detail(security.context(r).session, parse(identifier, r.params['id'])),
    ),
  );
  router.get('/payments', async (r, s) =>
    s.json(await module.payments.list(security.context(r).session, parse(pageQuery, r.query))),
  );
  router.get('/payments/:id/receipt', async (r, s) =>
    s.json(
      await module.payments.receipt(security.context(r).session, parse(identifier, r.params['id'])),
    ),
  );
  router.get('/notices', async (r, s) =>
    s.json(await module.community.notices(security.context(r).session, parse(pageQuery, r.query))),
  );
  router.get('/notices/:id', async (r, s) =>
    s.json(
      await module.community.notice(security.context(r).session, parse(identifier, r.params['id'])),
    ),
  );
  router.get('/complaints', async (r, s) =>
    s.json(
      await module.community.complaints(security.context(r).session, parse(pageQuery, r.query)),
    ),
  );
  router.get('/complaints/:id', async (r, s) =>
    s.json(
      await module.community.complaint(
        security.context(r).session,
        parse(identifier, r.params['id']),
      ),
    ),
  );
  router.post('/complaints', security.csrf, async (r, s) => {
    const session = security.context(r).session;
    await security.auth.rate('resident-complaint-user', session.userId ?? '', 10, 3600000);
    const result = await module.community.submit(
      session,
      parse(complaintInput, r.body),
      security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId'])),
    );
    s.status(201).json(result);
  });
  router.get('/complaints/:id/history', async (r, s) =>
    s.json(
      await module.community.history(
        security.context(r).session,
        parse(identifier, r.params['id']),
        parse(pageQuery, r.query),
      ),
    ),
  );
  return router;
}
