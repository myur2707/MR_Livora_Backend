import { Router } from 'express';
import type { Security } from '../http/security.js';
import type { CommunityAccess } from '../community/access.js';
import { ReportService } from './service.js';
import { CommitteeDashboard } from './dashboard.js';
import { parse, reportKind, reportQuery } from './contracts.js';
export function reportsModule(access: CommunityAccess) {
  return { service: new ReportService(access), dashboard: new CommitteeDashboard(access) };
}
export type ReportsModule = ReturnType<typeof reportsModule>;
export function reportsRouter(security: Security, module: ReportsModule) {
  const router = Router();
  router.use(security.authenticated);
  router.get('/society/dashboard', security.tenant('society.dashboard.manage'), async (r, s) =>
    s.json(await module.dashboard.summary(security.context(r).session)),
  );
  router.get(
    '/society/reports/:kind/export',
    security.tenant('society.reports.export'),
    async (r, s) => {
      const session = security.context(r).session;
      await security.auth.rate('report-export-user', session.userId ?? '', 10, 900000);
      const kind = parse(reportKind, r.params['kind']);
      const csv = await module.service.export(
        session,
        kind,
        parse(reportQuery, r.query),
        security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId'])),
      );
      s.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="livora-' + kind + '.csv"',
      }).send(csv);
    },
  );
  router.get('/society/reports/:kind', async (r, s) =>
    s.json(
      await module.service.list(
        security.context(r).session,
        parse(reportKind, r.params['kind']),
        parse(reportQuery, r.query),
      ),
    ),
  );
  return router;
}
