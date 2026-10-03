import type { Connection } from 'mysql2/promise';
export async function grantCommunityRuntime(
  db: Connection,
  schema: string,
  user: string,
  host: string,
): Promise<void> {
  if (
    !/^[a-z][a-z0-9_]+$/.test(schema) ||
    !/^[a-z][a-z0-9_]+$/.test(user) ||
    user === 'root' ||
    !['127.0.0.1', '%'].includes(host)
  )
    throw new Error('Invalid explicit community grant target.');
  for (const table of ['notices', 'notice_details', 'complaint_workflows'])
    await db.query('GRANT SELECT,INSERT,UPDATE ON ' + schema + '.' + table + ' TO ?@?', [
      user,
      host,
    ]);
  await db.query('GRANT SELECT,INSERT ON ' + schema + '.complaint_status_history TO ?@?', [
    user,
    host,
  ]);
}
export async function provisionCommunityPermissions(db: Connection): Promise<void> {
  await db.beginTransaction();
  try {
    for (const code of ['society.notices.manage', 'society.complaints.manage']) {
      await db.execute(
        'INSERT INTO permissions(code,description) VALUES(?,?) ON DUPLICATE KEY UPDATE code=VALUES(code)',
        [code, code],
      );
      await db.execute(
        "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT r.society_id,r.id,p.id FROM roles r JOIN permissions p ON p.code=? WHERE r.archived_at IS NULL AND r.code IN ('COMMITTEE_ADMIN','COMMITTEE_MEMBER') AND EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions old ON old.id=rp.permission_id WHERE rp.society_id=r.society_id AND rp.role_id=r.id AND old.code='society.dashboard.read') AND NOT EXISTS(SELECT 1 FROM role_permissions present WHERE present.society_id=r.society_id AND present.role_id=r.id AND present.permission_id=p.id)",
        [code],
      );
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
