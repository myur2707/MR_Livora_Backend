import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv, importHeaders } from '../src/property/imports/parser.js';
import { occupancyInput, buildingQuery, personInput } from '../src/property/contracts.js';
import { fingerprint, like } from '../src/property/models.js';
const header = importHeaders.FLATS.join(',');
void test('CSV accepts UTF-8 BOM and quoted fields, preserving physical and logical row numbers', () => {
  const rows = parseCsv('FLATS', '\uFEFF' + header + '\r\nA,"Block, A",101,900.00\r\n');
  assert.equal(rows[0]?.values['building_name'], 'Block, A');
  assert.equal(rows[0]?.rowNumber, 2);
  assert.equal(rows[0]?.lineNumber, 2);
  assert.deepEqual(rows[0]?.errors, []);
});
void test('CSV reports invalid cells and width by row; rejects unsafe structural inputs', () => {
  assert.ok(parseCsv('FLATS', header + '\nA,Building,101,-1')[0]?.errors.length);
  assert.equal(
    parseCsv('FLATS', header + '\nA,Building,101,900.00,extra')[0]?.errors[0]?.code,
    'COLUMN_COUNT',
  );
  for (const csv of [
    header,
    header + '\nA,"unclosed,101,900.00',
    header + '\n' + 'a'.repeat(5000),
    header + '\0\nA,B,1,1.00',
    header + '\n' + Array(501).fill('A,B,1,1.00').join('\n'),
    'code,name,number,area\nA,B,1,1.00',
  ])
    assert.throws(() => parseCsv('FLATS', csv));
});
void test('dates, mass assignment, identifiers and sorting are strict', () => {
  const valid = { personId: '1', occupancyType: 'TENANT', startsOn: '2024-02-29', endsOn: null };
  assert.ok(occupancyInput.safeParse(valid).success);
  for (const body of [
    { ...valid, startsOn: '2025-02-29' },
    { ...valid, endsOn: '2024-01-01' },
    { ...valid, userId: '1' },
    { ...valid, personId: '0' },
  ])
    assert.equal(occupancyInput.safeParse(body).success, false);
  assert.equal(buildingQuery.safeParse({ sort: 'password_hash' }).success, false);
  assert.equal(buildingQuery.safeParse({ pageSize: 51 }).success, false);
  assert.equal(
    personInput.safeParse({
      displayName: 'Resident',
      contactEmail: null,
      contactPhone: null,
      reference: null,
      role: 'PLATFORM_ADMIN',
    }).success,
    false,
  );
});
void test('review fingerprints tolerate MySQL JSON key order; search escapes wildcard characters', () => {
  assert.equal(fingerprint({ a: 1, b: { x: 2, y: 3 } }), fingerprint({ b: { y: 3, x: 2 }, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.equal(like('a_%='), '%a=_=%==%');
});
