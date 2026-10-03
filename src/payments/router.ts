import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Security } from '../http/security.js';
import type { BillingAccess } from '../billing/access.js';
import { PaymentRecording } from './recording.js';
import { PaymentLifecycle } from './lifecycle.js';
import { PaymentQueries } from './queries.js';
import {
  parse,
  identifier,
  recordInput,
  reverseInput,
  refundInput,
  correctionInput,
  listQuery,
} from './contracts.js';
export interface PaymentModule {
  recording: PaymentRecording;
  lifecycle: PaymentLifecycle;
  queries: PaymentQueries;
}
export function paymentModule(access: BillingAccess): PaymentModule {
  return {
    recording: new PaymentRecording(access),
    lifecycle: new PaymentLifecycle(access),
    queries: new PaymentQueries(access),
  };
}
export function paymentRouter(security: Security, module: PaymentModule) {
  const router = Router(),
    base = '/society/billing/payments';
  router.use(base, security.authenticated, security.tenant('society.finance.read'));
  const session = (r: Request) => security.context(r).session;
  const audit = (r: Request, s: Response) =>
    security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId']));
  const id = (r: Request) => parse(identifier, r.params['id']);
  router.get(base, async (r, s) =>
    s.json(await module.queries.list(session(r), parse(listQuery, r.query))),
  );
  router.get(base + '/report', async (r, s) =>
    s.json(await module.queries.report(session(r), parse(listQuery, r.query))),
  );
  for (const resource of ['collectors', 'payers', 'report-collectors'] as const)
    router.get(base + '/' + resource, async (r, s) =>
      s.json(await module.queries.choices(session(r), resource, parse(listQuery, r.query))),
    );
  router.get(base + '/:id', async (r, s) => s.json(await module.queries.detail(session(r), id(r))));
  router.get(base + '/:id/receipt', async (r, s) =>
    s.json(await module.queries.detail(session(r), id(r), true)),
  );
  router.post(base, security.csrf, security.tenant('society.finance.record'), async (r, s) => {
    await security.auth.rate('payment-recording', security.identity(r).userId, 60, 900000);
    s.status(201).json(
      await module.recording.record(session(r), parse(recordInput, r.body), audit(r, s)),
    );
  });
  for (const action of ['reverse', 'refund', 'correct'] as const)
    router.post(
      base + '/:id/' + action,
      security.csrf,
      security.tenant('society.finance.reverse'),
      async (r, s) => {
        await security.auth.rate('payment-lifecycle', security.identity(r).userId, 30, 900000);
        const result =
          action === 'reverse'
            ? await module.lifecycle.reverse(
                session(r),
                id(r),
                parse(reverseInput, r.body),
                audit(r, s),
              )
            : action === 'refund'
              ? await module.lifecycle.refund(
                  session(r),
                  id(r),
                  parse(refundInput, r.body),
                  audit(r, s),
                )
              : await module.lifecycle.correct(
                  session(r),
                  id(r),
                  parse(correctionInput, r.body),
                  audit(r, s),
                );
        s.json(result);
      },
    );
  return router;
}
