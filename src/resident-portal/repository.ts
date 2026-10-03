import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { rows } from '../onboarding/repository.js';
import type { PageQuery } from './contracts.js';
export type Values = (string | number)[];
export async function page<T extends RowDataPacket>(
  db: PoolConnection,
  select: string,
  source: string,
  values: Values,
  query: PageQuery,
) {
  const count = await rows<RowDataPacket & { total: string | number }>(
    db,
    'SELECT COUNT(*) AS total' + source,
    values,
  );
  const items = await rows<T>(db, select + source + ' ORDER BY id DESC LIMIT ? OFFSET ?', [
    ...values,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  ]);
  return { items, total: Number(count[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
}
