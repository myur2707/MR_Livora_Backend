import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { rows, notFound } from '../onboarding/repository.js';
import { ApiError } from '../http/errors.js';
import type { TenantScope } from '../property/access.js';
import type { PreviewInput } from './contracts.js';
import { bounded, minor, money, lineAmount, discountAmount } from './money.js';
import { balanceColumns, balance, type BalanceRow } from './balances.js';
export interface Period extends RowDataPacket {
  id: string;
  code: string;
  startsOn: string;
  endsOn: string;
  dueOn: string;
  kind: 'MONTHLY' | 'ONE_TIME';
}
interface Flat extends RowDataPacket {
  id: string;
  buildingId: string;
  buildingCode: string;
  flatNumber: string;
  area: string | null;
  occupied: number;
  existingBillId: string | null;
}
interface Configuration extends RowDataPacket {
  id: string;
  chargeTypeId: string;
  name: string;
  scope: 'SOCIETY' | 'BUILDING' | 'FLAT';
  buildingId: string | null;
  flatId: string | null;
  method: 'FLAT_RATE' | 'PER_SQ_FT';
  rate: string;
  effectiveUntil: string | null;
  eligibility: string;
  enabled: number;
}
export interface BillLine {
  configurationId: string;
  chargeTypeId: string;
  description: string;
  quantity: string;
  unitRate: string;
  amount: string;
}
export interface PlannedBill {
  flatId: string;
  buildingCode: string;
  flatNumber: string;
  status: 'READY' | 'ALREADY_BILLED' | 'NO_CHARGES';
  existingBillId: string | null;
  items: BillLine[];
  exclusions: string[];
  gross: string;
  discount: string;
  net: string;
  previousOutstanding: string;
  discountRequest: PreviewInput['discounts'][number] | null;
}
export interface Plan {
  period: Period;
  flats: PlannedBill[];
  gross: string;
  discount: string;
  net: string;
  previewHash: string;
}
export function canonical(input: PreviewInput) {
  return {
    periodId: input.periodId,
    flatIds: [...input.flatIds].sort(),
    discounts: [...input.discounts]
      .map((d) => ({ ...d, value: money(minor(d.value)) }))
      .sort((a, b) => a.flatId.localeCompare(b.flatId)),
  };
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const configScope = "COALESCE(d.scope,IF(c.flat_id IS NULL,'SOCIETY','FLAT'))";
export class BillingPlanner {
  async plan(db: PoolConnection, scope: TenantScope, input: PreviewInput): Promise<Plan> {
    const periods = await rows<Period>(
      db,
      "SELECT p.id,p.code,p.starts_on AS startsOn,p.ends_on AS endsOn,p.due_on AS dueOn,COALESCE(d.kind,'MONTHLY') AS kind FROM billing_periods p LEFT JOIN billing_period_details d ON d.society_id=p.society_id AND d.period_id=p.id WHERE p.society_id=? AND p.id=?",
      [scope.societyId, input.periodId],
    );
    const period = periods[0];
    if (!period) throw notFound();
    const placeholders = input.flatIds.map(() => '?').join(',');
    const flats = await rows<Flat>(
      db,
      `SELECT f.id,f.building_id AS buildingId,b.code AS buildingCode,f.flat_number AS flatNumber,f.area_sq_ft AS area,
      EXISTS(SELECT 1 FROM flat_occupancies o WHERE o.society_id=f.society_id AND o.flat_id=f.id AND o.starts_on<=? AND (o.ends_on IS NULL OR o.ends_on>=?)) AS occupied,
      (SELECT existing.id FROM bills existing WHERE existing.society_id=f.society_id AND existing.flat_id=f.id AND existing.billing_period_id=?) AS existingBillId
      FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.id IN (${placeholders}) AND f.archived_at IS NULL AND b.archived_at IS NULL ORDER BY f.id`,
      [period.startsOn, period.startsOn, period.id, scope.societyId, ...input.flatIds],
    );
    if (flats.length !== input.flatIds.length) throw notFound();
    const configurations = await rows<Configuration>(
      db,
      `SELECT c.id,c.charge_type_id AS chargeTypeId,t.name,${configScope} AS scope,d.building_id AS buildingId,c.flat_id AS flatId,c.calculation_method AS method,c.rate,c.effective_until AS effectiveUntil,COALESCE(d.eligibility,'ALL_FLATS') AS eligibility,COALESCE(d.enabled,1) AS enabled
      FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id AND t.archived_at IS NULL
      LEFT JOIN maintenance_charge_type_details td ON td.society_id=t.society_id AND td.charge_type_id=t.id
      LEFT JOIN maintenance_configuration_details d ON d.society_id=c.society_id AND d.configuration_id=c.id
      WHERE c.society_id=? AND c.effective_from<=? AND COALESCE(td.frequency,'MONTHLY')=? AND (c.flat_id IS NULL OR c.flat_id IN (${placeholders}))
      AND (d.building_id IS NULL OR d.building_id IN (${flats.map(() => '?').join(',')}))
      AND NOT EXISTS(SELECT 1 FROM maintenance_charge_configurations newer LEFT JOIN maintenance_configuration_details nd ON nd.society_id=newer.society_id AND nd.configuration_id=newer.id WHERE newer.society_id=c.society_id AND newer.charge_type_id=c.charge_type_id AND COALESCE(newer.flat_id,0)=COALESCE(c.flat_id,0) AND COALESCE(nd.building_id,0)=COALESCE(d.building_id,0) AND COALESCE(nd.scope,IF(newer.flat_id IS NULL,'SOCIETY','FLAT'))=${configScope} AND newer.effective_from<=? AND (newer.effective_from>c.effective_from OR (newer.effective_from=c.effective_from AND newer.version>c.version))) ORDER BY c.charge_type_id,c.id LIMIT 5001`,
      [
        scope.societyId,
        period.startsOn,
        period.kind,
        ...input.flatIds,
        ...flats.map((f) => f.buildingId),
        period.startsOn,
      ],
    );
    if (configurations.length > 5000)
      throw new ApiError(422, 'BILLING_LIMIT', 'Too many applicable configurations for one batch.');
    const used =
      period.kind === 'ONE_TIME'
        ? await rows<RowDataPacket & { flat_id: string; charge_type_id: string }>(
            db,
            `SELECT flat_id,charge_type_id FROM one_time_charge_applications WHERE society_id=? AND flat_id IN (${placeholders})`,
            [scope.societyId, ...input.flatIds],
          )
        : [];
    const balances = await rows<BalanceRow & { flatId: string }>(
      db,
      `SELECT b.flat_id AS flatId,b.status,p.due_on AS dueOn,${balanceColumns} FROM bills b JOIN billing_periods p ON p.society_id=b.society_id AND p.id=b.billing_period_id WHERE b.society_id=? AND b.status='ISSUED' AND b.billing_period_id<>? AND b.flat_id IN (${placeholders})`,
      [scope.societyId, period.id, ...input.flatIds],
    );
    const planned = flats.map((flat) =>
      this.flat(flat, period, configurations, used, input, balances, scope.today),
    );
    const totals = planned
      .filter((f) => f.status === 'READY')
      .reduce(
        (sum, f) => ({
          gross: bounded(sum.gross + minor(f.gross)),
          discount: bounded(sum.discount + minor(f.discount)),
          net: bounded(sum.net + minor(f.net)),
        }),
        { gross: 0n, discount: 0n, net: 0n },
      );
    const result = {
      period,
      flats: planned,
      gross: money(totals.gross),
      discount: money(totals.discount),
      net: money(totals.net),
    };
    return { ...result, previewHash: hash(result) };
  }
  private flat(
    flat: Flat,
    period: Period,
    configs: Configuration[],
    used: { flat_id: string; charge_type_id: string }[],
    input: PreviewInput,
    balances: (BalanceRow & { flatId: string })[],
    today: string,
  ): PlannedBill {
    const selected = new Map<string, Configuration>();
    const priority = { SOCIETY: 0, BUILDING: 1, FLAT: 2 };
    for (const config of configs) {
      if (
        (config.scope === 'FLAT' && config.flatId !== flat.id) ||
        (config.scope === 'BUILDING' && config.buildingId !== flat.buildingId)
      )
        continue;
      const prior = selected.get(config.chargeTypeId);
      if (!prior || priority[config.scope] > priority[prior.scope])
        selected.set(config.chargeTypeId, config);
    }
    const exclusions: string[] = [];
    const items: BillLine[] = [];
    for (const config of selected.values()) {
      let excluded = '';
      if (!config.enabled) excluded = 'Disabled rule';
      else if (config.effectiveUntil && config.effectiveUntil < period.startsOn)
        excluded = 'Expired rule';
      else if (config.eligibility === 'OCCUPIED_ONLY' && !flat.occupied)
        excluded = 'Vacant at period start';
      else if (used.some((u) => u.flat_id === flat.id && u.charge_type_id === config.chargeTypeId))
        excluded = 'One-time charge already billed';
      if (excluded) {
        exclusions.push(config.name + ': ' + excluded);
        continue;
      }
      const quantity = config.method === 'PER_SQ_FT' ? flat.area : '1.00';
      if (!quantity || minor(quantity) === 0n)
        throw new ApiError(
          422,
          'MISSING_AREA',
          'A selected flat needs a positive area for its per-square-foot charge.',
        );
      items.push({
        configurationId: config.id,
        chargeTypeId: config.chargeTypeId,
        description: config.name,
        quantity,
        unitRate: config.rate,
        amount: money(lineAmount(quantity, config.rate)),
      });
    }
    if (items.length > 100)
      throw new ApiError(422, 'BILLING_LIMIT', 'A bill cannot contain more than 100 charge lines.');
    const gross = items.reduce((sum, item) => bounded(sum + minor(item.amount)), 0n);
    const status = flat.existingBillId ? 'ALREADY_BILLED' : items.length ? 'READY' : 'NO_CHARGES';
    const discountRequest = input.discounts.find((d) => d.flatId === flat.id) ?? null;
    if (discountRequest && status !== 'READY')
      throw new ApiError(
        422,
        'INVALID_DISCOUNT',
        'Discounts require a selected flat with new billable charges.',
      );
    const discount = discountRequest
      ? discountAmount(gross, discountRequest.kind, discountRequest.value)
      : 0n;
    const previous = balances
      .filter((b) => b.flatId === flat.id)
      .reduce((sum, b) => bounded(sum + minor(balance(b, today).outstanding)), 0n);
    return {
      flatId: flat.id,
      buildingCode: flat.buildingCode,
      flatNumber: flat.flatNumber,
      status,
      existingBillId: flat.existingBillId,
      items,
      exclusions,
      gross: money(gross),
      discount: money(discount),
      net: money(gross - discount),
      previousOutstanding: money(previous),
      discountRequest,
    };
  }
}
