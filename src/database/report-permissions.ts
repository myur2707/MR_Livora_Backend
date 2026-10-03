import type { Connection } from 'mysql2/promise';
export async function provisionReportPermissions(db: Connection): Promise<void> {
  await db.beginTransaction();
  try {
    for (const code of ['society.dashboard.manage', 'society.reports.export']) {
      await db.execute(
        'INSERT INTO permissions(code,description) VALUES(?,?) ON DUPLICATE KEY UPDATE code=VALUES(code)',
        [code, code],
      );
      await db.execute(
        "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT r.society_id,r.id,p.id FROM roles r JOIN permissions p ON p.code=? WHERE r.archived_at IS NULL AND r.code IN ('COMMITTEE_ADMIN','COMMITTEE_MEMBER','ACCOUNTANT') AND (?='society.dashboard.manage' OR r.code IN ('COMMITTEE_ADMIN','ACCOUNTANT')) AND EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions existing ON existing.id=rp.permission_id WHERE rp.society_id=r.society_id AND rp.role_id=r.id AND existing.code=IF(?='society.dashboard.manage','society.dashboard.read','society.finance.read')) AND NOT EXISTS(SELECT 1 FROM role_permissions existing WHERE existing.society_id=r.society_id AND existing.role_id=r.id AND existing.permission_id=p.id)",
        [code, code, code],
      );
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
