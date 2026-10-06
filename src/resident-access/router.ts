import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Security } from '../http/security.js';
import type { ResidentAccounts } from './accounts.js';
import type { ResidentInvitations } from './invitations.js';
import type { ResidentRequests } from './requests.js';
import {
  parse,
  identifier,
  signupSchema,
  tokenSchema,
  acceptanceSchema,
  inviteSchema,
  joinSchema,
  joinSocietyOptionsSchema,
  joinPropertyOptionsSchema,
  pageSchema,
  decisionSchema,
  approvalSchema,
} from './contracts.js';
export interface ResidentAccessModule {
  accounts: ResidentAccounts;
  invitations: ResidentInvitations;
  requests: ResidentRequests;
}
export function residentAccessRouter(security: Security, module: ResidentAccessModule) {
  const router = Router();
  const session = (r: Request) => security.context(r).session;
  const audit = (r: Request, s: Response) =>
    security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId']));
  const id = (r: Request) => parse(identifier, r.params['id']);
  const rate = (scope: string, key: string, limit: number) =>
    security.auth.rate(scope, key, limit, 900000);
  router.post('/resident-access/account/start', security.csrf, async (r, s) => {
    await rate('resident-signup-ip', r.ip ?? 'unknown', 10);
    const body = parse(signupSchema, r.body);
    await rate('resident-signup-email', body.email, 3);
    module.accounts.start(body, audit(r, s));
    s.status(202).json({
      message:
        'If eligible, instructions will be sent to this email. Existing accounts should sign in.',
    });
  });
  router.post('/resident-access/account/verify', security.csrf, async (r, s) => {
    await rate('resident-verify-ip', r.ip ?? 'unknown', 10);
    const body = parse(tokenSchema, r.body);
    await rate('resident-verify-token', body.token, 5);
    await module.accounts.verify(body.token, audit(r, s));
    s.sendStatus(204);
  });
  for (const action of ['inspect', 'accept'] as const)
    router.post('/resident-access/invitations/' + action, security.csrf, async (r, s) => {
      await rate('resident-invite-' + action + '-ip', r.ip ?? 'unknown', 10);
      if (action === 'inspect') {
        const body = parse(tokenSchema, r.body);
        s.json(await module.invitations.inspect(body.token));
      } else {
        const body = parse(acceptanceSchema, r.body);
        await rate('resident-invite-token', body.token, 5);
        await module.invitations.accept(session(r), body.token, body.password, audit(r, s));
        s.sendStatus(204);
      }
    });
  router.get('/resident-access/requests', security.authenticated, async (r, s) =>
    s.json(await module.requests.own(session(r), parse(pageSchema, r.query))),
  );
  router.get('/resident-access/join-options/societies', security.authenticated, async (r, s) => {
    await rate('resident-join-options', security.identity(r).userId, 60);
    const query = parse(joinSocietyOptionsSchema, r.query);
    s.json(await module.requests.societyOptions(session(r), query.search));
  });
  router.get('/resident-access/join-options/properties', security.authenticated, async (r, s) => {
    await rate('resident-join-options', security.identity(r).userId, 60);
    s.json(
      await module.requests.propertyOptions(session(r), parse(joinPropertyOptionsSchema, r.query)),
    );
  });
  router.post('/resident-access/requests', security.csrf, security.authenticated, async (r, s) => {
    await rate('resident-join-user', security.identity(r).userId, 5);
    s.status(201).json(
      await module.requests.join(session(r), parse(joinSchema, r.body), audit(r, s)),
    );
  });
  router.post(
    '/resident-access/requests/:id/cancel',
    security.csrf,
    security.authenticated,
    async (r, s) => {
      parse(decisionSchema, r.body);
      await module.requests.cancel(session(r), id(r), audit(r, s));
      s.sendStatus(204);
    },
  );
  const guards = [security.authenticated, security.tenant('society.members.manage')];
  router.get('/society/resident-invitations', ...guards, async (r, s) =>
    s.json(await module.invitations.list(session(r), parse(pageSchema, r.query))),
  );
  router.get('/society/registration-requests', ...guards, async (r, s) =>
    s.json(await module.requests.pending(session(r), parse(pageSchema, r.query))),
  );
  router.post('/society/resident-invitations', security.csrf, ...guards, async (r, s) => {
    const body = parse(inviteSchema, r.body);
    await rate(
      'resident-invite-create',
      security.identity(r).userId + ':' + security.identity(r).activeSociety?.societyId,
      5,
    );
    s.status(201).json(
      await module.invitations.invite(session(r), body.personId, body.flatId, audit(r, s)),
    );
  });
  for (const action of ['resend', 'revoke'] as const)
    router.post(
      '/society/resident-invitations/:id/' + action,
      security.csrf,
      ...guards,
      async (r, s) => {
        const body = parse(decisionSchema, r.body);
        await rate(
          'resident-invite-create',
          security.identity(r).userId + ':' + security.identity(r).activeSociety?.societyId,
          5,
        );
        if (action === 'resend')
          s.status(201).json(
            await module.invitations.resend(session(r), id(r), audit(r, s), body.note),
          );
        else {
          await module.invitations.revoke(session(r), id(r), audit(r, s), body.note);
          s.sendStatus(204);
        }
      },
    );
  router.post(
    '/society/registration-requests/:id/approve',
    security.csrf,
    ...guards,
    async (r, s) => {
      await module.requests.approve(session(r), id(r), parse(approvalSchema, r.body), audit(r, s));
      s.sendStatus(204);
    },
  );
  router.post(
    '/society/registration-requests/:id/reject',
    security.csrf,
    ...guards,
    async (r, s) => {
      const body = parse(decisionSchema, r.body);
      await module.requests.reject(session(r), id(r), body.note, audit(r, s));
      s.sendStatus(204);
    },
  );
  return router;
}
