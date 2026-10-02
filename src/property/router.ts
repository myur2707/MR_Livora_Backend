import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Security } from '../http/security.js';
import type { PropertyService } from './service.js';
import type { OccupancyService } from './occupancies.js';
import type { ImportService } from './imports/service.js';
import {
  parse,
  identifier,
  buildingInput,
  flatInput,
  personInput,
  updateBuilding,
  updateFlat,
  updatePerson,
  archiveInput,
  buildingQuery,
  flatQuery,
  personQuery,
  occupancyInput,
  occupancyQuery,
  closeInput,
  importPageQuery,
  previewInput,
  importConfirmInput,
  cancelInput,
} from './contracts.js';
export interface PropertyModule {
  service: PropertyService;
  occupancy: OccupancyService;
  imports: ImportService;
}
export function propertyRouter(security: Security, module: PropertyModule) {
  const router = Router();
  const { service, occupancy, imports } = module;
  router.use(security.authenticated, security.tenant('society.members.manage'));
  const session = (r: Request) => security.context(r).session;
  const id = (r: Request) => parse(identifier, r.params['id']);
  const flatId = (r: Request) => parse(identifier, r.params['flatId']);
  const audit = (r: Request, s: Response) =>
    security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId']));
  for (const kind of ['buildings', 'flats', 'persons'] as const) {
    const prefix = '/society/' + kind;
    router.get(prefix, async (r, s) => {
      const query =
        kind === 'buildings'
          ? parse(buildingQuery, r.query)
          : kind === 'flats'
            ? parse(flatQuery, r.query)
            : parse(personQuery, r.query);
      s.json(await service.list(session(r), kind, query));
    });
    router.get(prefix + '/:id', async (r, s) =>
      s.json(await service.detail(session(r), kind, id(r))),
    );
    router.post(prefix, security.csrf, async (r, s) => {
      const result =
        kind === 'buildings'
          ? await service.addBuilding(session(r), parse(buildingInput, r.body), audit(r, s))
          : kind === 'flats'
            ? await service.addFlat(session(r), parse(flatInput, r.body), audit(r, s))
            : await service.addPerson(session(r), parse(personInput, r.body), audit(r, s));
      s.status(201).json(result);
    });
    router.put(prefix + '/:id', security.csrf, async (r, s) => {
      if (kind === 'buildings')
        await service.editBuilding(session(r), id(r), parse(updateBuilding, r.body), audit(r, s));
      else if (kind === 'flats')
        await service.editFlat(session(r), id(r), parse(updateFlat, r.body), audit(r, s));
      else await service.editPerson(session(r), id(r), parse(updatePerson, r.body), audit(r, s));
      s.sendStatus(204);
    });
    router.post(prefix + '/:id/archive', security.csrf, async (r, s) => {
      await service.archive(
        session(r),
        kind,
        id(r),
        parse(archiveInput, r.body).version,
        audit(r, s),
      );
      s.sendStatus(204);
    });
  }
  router.get('/society/flats/:flatId/occupancies', async (r, s) =>
    s.json(await occupancy.list(session(r), flatId(r), parse(occupancyQuery, r.query))),
  );
  router.post('/society/flats/:flatId/occupancies', security.csrf, async (r, s) =>
    s
      .status(201)
      .json(await occupancy.add(session(r), flatId(r), parse(occupancyInput, r.body), audit(r, s))),
  );
  router.post('/society/flats/:flatId/occupancies/:id/close', security.csrf, async (r, s) => {
    await occupancy.close(session(r), flatId(r), id(r), parse(closeInput, r.body), audit(r, s));
    s.sendStatus(204);
  });
  router.get('/society/imports', async (r, s) =>
    s.json(await imports.list(session(r), parse(importPageQuery, r.query))),
  );
  router.get('/society/imports/:id', async (r, s) =>
    s.json(await imports.detail(session(r), id(r))),
  );
  router.get('/society/imports/:id/rows', async (r, s) =>
    s.json(await imports.previewRows(session(r), id(r), parse(importPageQuery, r.query))),
  );
  router.post('/society/imports/preview', security.csrf, async (r, s) => {
    await security.auth.rate('property-import-preview', security.identity(r).userId, 20, 900000);
    s.status(201).json(await imports.preview(session(r), parse(previewInput, r.body), audit(r, s)));
  });
  router.post('/society/imports/:id/revalidate', security.csrf, async (r, s) => {
    parse(cancelInput, r.body);
    s.json(await imports.revalidate(session(r), id(r), audit(r, s)));
  });
  router.post('/society/imports/:id/cancel', security.csrf, async (r, s) => {
    parse(cancelInput, r.body);
    await imports.cancel(session(r), id(r), audit(r, s));
    s.sendStatus(204);
  });
  router.post('/society/imports/:id/confirm', security.csrf, async (r, s) =>
    s.json(
      await imports.confirm(session(r), id(r), parse(importConfirmInput, r.body), audit(r, s)),
    ),
  );
  return router;
}
