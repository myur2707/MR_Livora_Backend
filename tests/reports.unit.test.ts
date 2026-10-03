import assert from 'node:assert/strict';
import test from 'node:test';
import { parse as parseCsv } from 'csv-parse/sync';
import { reportCsv, csvCell } from '../src/reports/csv.js';
import { reportQuery, validateFilters } from '../src/reports/contracts.js';
import { utcRange, dayStart, nextDate } from '../src/reports/dates.js';
import { decimalMoney } from '../src/reports/service.js';
void test('CSV formulas, leading whitespace/controls, quotes and multiline cells are safely escaped', () => {
  const values = [
    '=SUM(1,2)',
    '+12345',
    '-2.00',
    '@cmd',
    ' \t=HYPERLINK("x")',
    '\rnormal',
    '\nnormal',
    '\tplain',
    '\uFEFF@formula',
    'plain, "quoted"\nnext',
    '🙂',
  ];
  const csv = reportCsv(
    [{ key: 'value', label: 'Value', type: 'text' }],
    values.map((value) => ({ value })),
  );
  const rows: unknown = parseCsv(csv, { bom: true, columns: true });
  assert.ok(Array.isArray(rows));
  for (const [index, value] of values.entries()) {
    const row: unknown = rows[index];
    assert.ok(typeof row === 'object' && row !== null && 'Value' in row);
    assert.equal(row.Value, index < 9 ? "'" + value : value);
  }
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('normal'), '"normal"');
});
void test('society local day boundaries use half-open UTC ranges including DST and skipped days', () => {
  assert.deepEqual(utcRange('2026-10-03', '2026-10-03', 'Asia/Kolkata'), [
    '2026-10-02 18:30:00.000',
    '2026-10-03 18:30:00.000',
  ]);
  const start = dayStart('2026-03-08', 'America/New_York'),
    end = dayStart('2026-03-09', 'America/New_York');
  assert.equal(end - start, 23 * 3600000);
  assert.equal(new Date(start).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(
    dayStart('2026-11-02', 'America/New_York') - dayStart('2026-11-01', 'America/New_York'),
    25 * 3600000,
  );
  assert.equal(dayStart('2011-12-30', 'Pacific/Apia'), dayStart('2011-12-31', 'Pacific/Apia'));
  assert.equal(nextDate('2028-02-29'), '2028-03-01');
});
void test('report schemas validate paired ranges, allowlisted filters/sorts and page limits', () => {
  for (const fields of [
    { from: '2026-10-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-03', to: '2026-10-02' },
    { from: '2025-01-01', to: '2026-01-02' },
    { pageSize: 51 },
    { page: 0 },
    { sort: 'id; DROP' },
    { direction: 'descending' },
    { societyId: '1' },
  ])
    assert.equal(reportQuery.safeParse(fields).success, false);
  const query = reportQuery.parse({ from: '2028-02-29', to: '2028-02-29' });
  validateFilters('billing', query);
  assert.throws(() => validateFilters('residents', { ...query, method: 'CASH' }));
  assert.throws(() => validateFilters('collection', { ...query, sort: 'name' }));
  assert.throws(() => validateFilters('cash-collection', { ...query, method: 'UPI' }));
});
void test('exact report decimal formatting supports signed aggregates larger than single records', () => {
  assert.equal(decimalMoney('123456789012345.67'), '123456789012345.67');
  assert.equal(decimalMoney('-20.05'), '-20.05');
  assert.equal(decimalMoney('0'), '0.00');
  assert.equal(decimalMoney('100.2'), '100.20');
  for (const value of [0.1, '1e10', '1.001', null]) assert.throws(() => decimalMoney(value));
});
