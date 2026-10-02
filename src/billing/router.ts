import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Security } from '../http/security.js';
import { BillingConfiguration } from './configuration.js';
import { BillingGeneration } from './generation.js';
import { BillingQueries } from './queries.js';
import type { BillingAccess } from './access.js';
import {
  parse,
  identifier,
  typeInput,
  configurationInput,
  periodInput,
  listQuery,
  previewInput,
  generationInput,
} from './contracts.js';
export interface BillingModule {
  configuration: BillingConfiguration;
  generation: BillingGeneration;
  queries: BillingQueries;
}
export function billingModule(access: BillingAccess): BillingModule {
  return {
    configuration: new BillingConfiguration(access),
    generation: new BillingGeneration(access),
    queries: new BillingQueries(access),
  };
}
export function billingRouter(security: Security, module: BillingModule) {
  const router = Router();
  router.use('/society/billing', security.authenticated, security.tenant('society.finance.read'));
  const session = (r: Request) => security.context(r).session;
  const audit = (r: Request, s: Response) =>
    security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId']));
  for (const resource of [
    'charge-types',
    'configurations',
    'periods',
    'buildings',
    'flats',
  ] as const)
    router.get('/society/billing/' + resource, async (r, s) =>
      s.json(await module.configuration.list(session(r), resource, parse(listQuery, r.query))),
    );
  router.post(
    '/society/billing/charge-types',
    security.csrf,
    security.tenant('society.finance.configure'),
    async (r, s) =>
      s
        .status(201)
        .json(
          await module.configuration.addType(session(r), parse(typeInput, r.body), audit(r, s)),
        ),
  );
  router.post(
    '/society/billing/configurations',
    security.csrf,
    security.tenant('society.finance.configure'),
    async (r, s) =>
      s
        .status(201)
        .json(
          await module.configuration.addConfiguration(
            session(r),
            parse(configurationInput, r.body),
            audit(r, s),
          ),
        ),
  );
  router.post(
    '/society/billing/periods',
    security.csrf,
    security.tenant('society.finance.configure'),
    async (r, s) =>
      s
        .status(201)
        .json(
          await module.configuration.addPeriod(session(r), parse(periodInput, r.body), audit(r, s)),
        ),
  );
  router.post(
    '/society/billing/preview',
    security.csrf,
    security.tenant('society.finance.generate'),
    async (r, s) =>
      s.json(await module.generation.preview(session(r), parse(previewInput, r.body))),
  );
  router.post(
    '/society/billing/generate',
    security.csrf,
    security.tenant('society.finance.generate'),
    async (r, s) => {
      await security.auth.rate('billing-generation', security.identity(r).userId, 30, 900000);
      s.json(
        await module.generation.generate(session(r), parse(generationInput, r.body), audit(r, s)),
      );
    },
  );
  router.get('/society/billing/bills', async (r, s) =>
    s.json(await module.queries.list(session(r), parse(listQuery, r.query))),
  );
  router.get('/society/billing/outstanding', async (r, s) =>
    s.json(await module.queries.list(session(r), parse(listQuery, r.query), true)),
  );
  router.get('/society/billing/bills/:id', async (r, s) =>
    s.json(await module.queries.detail(session(r), parse(identifier, r.params['id']))),
  );
  return router;
}
