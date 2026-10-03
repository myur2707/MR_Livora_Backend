import { Router } from 'express';
import type { Security } from '../http/security.js';
import type { CommunityAccess } from './access.js';
import { CommunityNotices } from './notices.js';
import { CommitteeComplaints } from './complaints.js';
import {
  parse,
  identifier,
  pageQuery,
  noticeQuery,
  noticeInput,
  noticeEdit,
  noticeAction,
  complaintQuery,
  complaintAction,
} from './contracts.js';
export function communityModule(access: CommunityAccess) {
  return {
    access,
    notices: new CommunityNotices(access),
    complaints: new CommitteeComplaints(access),
  };
}
export type CommunityModule = ReturnType<typeof communityModule>;
export function communityRouter(security: Security, module: CommunityModule) {
  const router = Router();
  router.use(security.authenticated);
  router.use('/notices', security.tenant('society.notices.manage'));
  router.use('/complaints', security.tenant('society.complaints.manage'));
  const session = (r: Parameters<Security['context']>[0]) => security.context(r).session;
  const audit = (r: Parameters<Security['context']>[0], id: unknown) =>
    security.auth.audit(r.ip ?? 'unknown', String(id));
  router.get('/notices', async (r, s) =>
    s.json(await module.notices.list(session(r), parse(noticeQuery, r.query))),
  );
  router.get('/notices/:id', async (r, s) =>
    s.json(await module.notices.detail(session(r), parse(identifier, r.params['id']))),
  );
  router.post('/notices', security.csrf, async (r, s) =>
    s
      .status(201)
      .json(
        await module.notices.create(
          session(r),
          parse(noticeInput, r.body),
          audit(r, s.locals['requestId']),
        ),
      ),
  );
  router.post('/notices/:id/edit', security.csrf, async (r, s) => {
    const input = parse(noticeEdit, r.body);
    s.json(
      await module.notices.change(
        session(r),
        parse(identifier, r.params['id']),
        input.revision,
        audit(r, s.locals['requestId']),
        { title: input.title, body: input.body },
      ),
    );
  });
  router.post('/notices/:id/action', security.csrf, async (r, s) => {
    const input = parse(noticeAction, r.body);
    s.json(
      await module.notices.change(
        session(r),
        parse(identifier, r.params['id']),
        input.revision,
        audit(r, s.locals['requestId']),
        { action: input.action },
      ),
    );
  });
  router.get('/complaints/assignees', async (r, s) =>
    s.json(await module.complaints.assignees(session(r), parse(pageQuery, r.query))),
  );
  router.get('/complaints', async (r, s) =>
    s.json(await module.complaints.list(session(r), parse(complaintQuery, r.query))),
  );
  router.get('/complaints/:id', async (r, s) =>
    s.json(await module.complaints.detail(session(r), parse(identifier, r.params['id']))),
  );
  router.get('/complaints/:id/history', async (r, s) =>
    s.json(
      await module.complaints.history(
        session(r),
        parse(identifier, r.params['id']),
        parse(pageQuery, r.query),
      ),
    ),
  );
  router.post('/complaints/:id/status', security.csrf, async (r, s) =>
    s.json(
      await module.complaints.change(
        session(r),
        parse(identifier, r.params['id']),
        parse(complaintAction, r.body),
        audit(r, s.locals['requestId']),
      ),
    ),
  );
  return router;
}
