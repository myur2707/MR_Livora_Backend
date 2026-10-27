import type { RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { rows, utcTimestamp } from './repository.js';
import type { OnboardingRepository } from './repository.js';
import { auditModuleOf, auditModules, parseStructureDetails } from './contracts.js';
import type { AuditTrailQuery } from './contracts.js';

interface AuditRow extends RowDataPacket {
  id: string;
  societyId: string;
  societyName: string;
  societyCode: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: unknown;
  actorEmail: string | null;
  actorPlatform: number | string;
  fromStatus: string | null;
  toStatus: string | null;
  details: unknown;
}

/**
 * Platform-wide audit trail: who did what, when, to which record, in every module.
 * Deliberately reads only who/what/when columns (never safe_metadata or business tables),
 * so Platform Admin sees activity without any society's private or financial values. Setup
 * rows add their onboarding event's status change and structure facts (wing codes, flat and
 * row house numbers), which the platform entered itself during setup.
 */
/**
 * One column of the setup event written with this audit row (same society, request and action).
 * Older batch saves wrote several events per request; the first one is used.
 */
function setupEvent(column: string, alias: string): string {
  return (
    '(SELECT ' +
    column +
    ' FROM society_onboarding_events e LEFT JOIN society_onboarding_event_details d ON d.society_id=e.society_id AND d.event_id=e.id' +
    " WHERE a.entity_type='society' AND e.society_id=a.society_id AND e.request_id=a.request_id AND e.action=a.action ORDER BY e.id LIMIT 1) AS " +
    alias
  );
}

export class PlatformAuditTrail {
  constructor(private readonly repository: OnboardingRepository) {}

  async list(session: Session, query: AuditTrailQuery) {
    return this.repository.database.transaction(async (db) => {
      await this.repository.platform(db, session);
      const where: string[] = [];
      const values: (string | number)[] = [];
      if (query.societyId) {
        where.push('a.society_id=?');
        values.push(query.societyId);
      }
      if (query.module) {
        const types = auditModules[query.module];
        where.push('a.entity_type IN (' + types.map(() => '?').join(',') + ')');
        values.push(...types);
      }
      if (query.from) {
        where.push('a.created_at>=?');
        values.push(query.from + ' 00:00:00');
      }
      if (query.to) {
        where.push('a.created_at<DATE_ADD(?,INTERVAL 1 DAY)');
        values.push(query.to);
      }
      if (query.search) {
        const like = '%' + query.search.replace(/[=%_]/g, '=$&') + '%';
        where.push(
          "(a.action LIKE ? ESCAPE '=' OR u.email_normalized LIKE ? ESCAPE '=' OR s.name LIKE ? ESCAPE '=' OR s.code LIKE ? ESCAPE '=')",
        );
        values.push(like, like, like, like);
      }
      const source =
        ' FROM audit_logs a JOIN societies s ON s.id=a.society_id LEFT JOIN users u ON u.id=a.actor_user_id' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '');
      const total = await rows<RowDataPacket & { total: string | number }>(
        db,
        'SELECT COUNT(*) AS total' + source,
        values,
      );
      const items = await rows<AuditRow>(
        db,
        'SELECT a.id,a.society_id AS societyId,s.name AS societyName,s.code AS societyCode,a.action,a.entity_type AS entityType,a.entity_id AS entityId,a.created_at AS createdAt,u.email_normalized AS actorEmail,EXISTS(SELECT 1 FROM platform_user_roles pr WHERE pr.user_id=a.actor_user_id) AS actorPlatform,' +
          setupEvent('e.from_status', 'fromStatus') +
          ',' +
          setupEvent('e.to_status', 'toStatus') +
          ',' +
          setupEvent('d.details', 'details') +
          source +
          ' ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items: items.map((row) => ({
          id: String(row.id),
          societyId: String(row.societyId),
          societyName: row.societyName,
          societyCode: row.societyCode,
          module: auditModuleOf(row.entityType),
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId === null ? null : String(row.entityId),
          actorEmail: row.actorEmail,
          actorPlatform: Number(row.actorPlatform) === 1,
          createdAt: utcTimestamp(row.createdAt),
          fromStatus: row.fromStatus,
          toStatus: row.toStatus,
          details: parseStructureDetails(row.details),
        })),
        total: Number(total[0]?.total ?? 0),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }
}
