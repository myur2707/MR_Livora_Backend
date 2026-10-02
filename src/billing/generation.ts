import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import type { TenantScope } from '../property/access.js';
import { sqlTime } from '../auth/repository.js';
import { insert, rows } from '../onboarding/repository.js';
import { ApiError } from '../http/errors.js';
import type { BillingAccess } from './access.js';
import { BillingPlanner, hash, canonical, type Plan, type PlannedBill } from './planning.js';
import type { PreviewInput, GenerationInput } from './contracts.js';
import { money, minor } from './money.js';
export class BillWriter {
  async write(
    db: PoolConnection,
    scope: TenantScope,
    plan: Plan,
    flat: PlannedBill,
    runId: string,
    issuedAt: string,
  ): Promise<string> {
    const id = await insert(
      db,
      'INSERT INTO bills(society_id,billing_period_id,flat_id,bill_number,total_amount) VALUES(?,?,?,?,?)',
      [
        scope.societyId,
        plan.period.id,
        flat.flatId,
        'B-' + plan.period.id + '-' + flat.flatId,
        flat.gross,
      ],
    );
    for (const [index, line] of flat.items.entries()) {
      await db.execute(
        'INSERT INTO bill_items(society_id,bill_id,charge_configuration_id,line_number,description,quantity,unit_rate,amount) VALUES(?,?,?,?,?,?,?,?)',
        [
          scope.societyId,
          id,
          line.configurationId,
          index + 1,
          line.description,
          line.quantity,
          line.unitRate,
          line.amount,
        ],
      );
      if (plan.period.kind === 'ONE_TIME')
        await db.execute(
          'INSERT INTO one_time_charge_applications(society_id,charge_type_id,configuration_id,flat_id,bill_id) VALUES(?,?,?,?,?)',
          [scope.societyId, line.chargeTypeId, line.configurationId, flat.flatId, id],
        );
    }
    await db.execute(
      'INSERT INTO billing_bill_details(society_id,bill_id,run_id,flat_id,building_code,flat_number,period_code,starts_on,ends_on,due_on,previous_outstanding) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [
        scope.societyId,
        id,
        runId,
        flat.flatId,
        flat.buildingCode,
        flat.flatNumber,
        plan.period.code,
        plan.period.startsOn,
        plan.period.endsOn,
        plan.period.dueOn,
        flat.previousOutstanding,
      ],
    );
    if (flat.discountRequest) {
      const adjustment = await insert(
        db,
        'INSERT INTO bill_adjustments(society_id,bill_id,amount,reason,idempotency_key,recorded_by_membership_id) VALUES(?,?,?,?,?,?)',
        [
          scope.societyId,
          id,
          flat.discount,
          flat.discountRequest.reason,
          'billing-discount-' + runId + '-' + flat.flatId,
          scope.membershipId,
        ],
      );
      await db.execute(
        'INSERT INTO billing_discount_details(society_id,adjustment_id,kind,value,gross_basis) VALUES(?,?,?,?,?)',
        [
          scope.societyId,
          adjustment,
          flat.discountRequest.kind,
          money(minor(flat.discountRequest.value)),
          flat.gross,
        ],
      );
    }
    await db.execute(
      "UPDATE bills SET status='ISSUED',issued_at=?,issued_by_membership_id=? WHERE society_id=? AND id=? AND status='DRAFT'",
      [issuedAt, scope.membershipId, scope.societyId, id],
    );
    return id;
  }
}
export class BillingGeneration {
  constructor(
    readonly access: BillingAccess,
    readonly planner = new BillingPlanner(),
    readonly writer = new BillWriter(),
  ) {}
  async preview(session: Session, input: PreviewInput) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.generate');
      if (input.discounts.length) await this.access.tenant(db, session, 'society.finance.discount');
      return this.planner.plan(db, scope, canonical(input));
    });
  }
  async generate(session: Session, input: GenerationInput, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.generate');
      if (input.discounts.length) await this.access.tenant(db, session, 'society.finance.discount');
      const normalized = canonical(input);
      const requestHash = hash({ ...normalized, previewHash: input.previewHash });
      const existing = await rows<
        RowDataPacket & { id: string; request_hash: Buffer; status: string }
      >(
        db,
        'SELECT id,request_hash,status FROM billing_generation_runs WHERE society_id=? AND idempotency_key=?',
        [scope.societyId, input.idempotencyKey],
      );
      if (existing[0]) {
        if (
          existing[0].request_hash.toString('hex') !== requestHash ||
          existing[0].status !== 'COMPLETED'
        )
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request key was used for a different request.',
          );
        return this.result(db, scope.societyId, existing[0].id, true);
      }
      const plan = await this.planner.plan(db, scope, normalized);
      if (plan.previewHash !== input.previewHash)
        throw new ApiError(
          409,
          'PREVIEW_CHANGED',
          'Billing data changed. Review a fresh preview before generating.',
        );
      const ready = plan.flats.filter((f) => f.status === 'READY');
      if (!ready.length)
        throw new ApiError(409, 'NO_NEW_BILLS', 'The selected flats have no new billable charges.');
      const id = await insert(
        db,
        'INSERT INTO billing_generation_runs(society_id,period_id,idempotency_key,request_hash,preview_hash,recorded_by_membership_id) VALUES(?,?,?,?,?,?)',
        [
          scope.societyId,
          plan.period.id,
          input.idempotencyKey,
          Buffer.from(requestHash, 'hex'),
          Buffer.from(plan.previewHash, 'hex'),
          scope.membershipId,
        ],
      );
      const issuedAt = sqlTime(this.access.clock());
      for (const flat of ready) {
        const billId = await this.writer.write(db, scope, plan, flat, id, issuedAt);
        await this.access.audit(db, scope, 'BILL_ISSUED', 'bill', billId, audit, { runId: id });
        if (flat.discountRequest)
          await this.access.audit(db, scope, 'BILL_DISCOUNT_AUTHORIZED', 'bill', billId, audit, {
            runId: id,
            kind: flat.discountRequest.kind,
          });
      }
      await db.execute(
        "UPDATE billing_generation_runs SET status='COMPLETED',bill_count=?,completed_at=? WHERE society_id=? AND id=?",
        [ready.length, issuedAt, scope.societyId, id],
      );
      await this.access.audit(
        db,
        scope,
        'BILL_GENERATION_COMPLETED',
        'billing_generation_run',
        id,
        audit,
        { billCount: ready.length, skippedCount: plan.flats.length - ready.length },
      );
      return this.result(db, scope.societyId, id, false);
    });
  }
  private async result(db: PoolConnection, societyId: string, id: string, replayed: boolean) {
    const billIds = await rows<RowDataPacket & { billId: string }>(
      db,
      'SELECT bill_id AS billId FROM billing_bill_details WHERE society_id=? AND run_id=? ORDER BY id',
      [societyId, id],
    );
    return {
      runId: id,
      billIds: billIds.map((b) => b.billId),
      billCount: billIds.length,
      replayed,
    };
  }
}
