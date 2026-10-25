import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RequestAudit, Session } from '../auth/types.js';
import { rows } from '../onboarding/repository.js';
import type { PropertyService } from '../property/service.js';
import type { SocietyContactInput } from './contracts.js';

export interface SocietyContact {
  contactPhone: string | null;
  contactEmail: string | null;
}
interface ContactRow extends RowDataPacket {
  society_id: string;
  contact_phone: string | null;
  contact_email: string | null;
}
const empty: SocietyContact = { contactPhone: null, contactEmail: null };
const toContact = (row: ContactRow): SocietyContact => ({
  contactPhone: row.contact_phone,
  contactEmail: row.contact_email,
});

/**
 * The contact a committee chooses to publish to applicants. Nothing personal is exposed unless a
 * committee admin enters it here, and applicants only see it on their own pending requests.
 */
export class SocietyContacts {
  constructor(private readonly property: PropertyService) {}

  async get(session: Session): Promise<SocietyContact> {
    return this.property.within(session, false, async (db, scope) => {
      const row = (
        await rows<ContactRow>(
          db,
          'SELECT society_id,contact_phone,contact_email FROM society_contacts WHERE society_id=?',
          [scope.societyId],
        )
      )[0];
      return row ? toContact(row) : empty;
    });
  }

  async update(
    session: Session,
    input: SocietyContactInput,
    audit: RequestAudit,
  ): Promise<SocietyContact> {
    return this.property.within(session, true, async (db, scope) => {
      await db.execute(
        'INSERT INTO society_contacts(society_id,contact_phone,contact_email,updated_by_membership_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE contact_phone=VALUES(contact_phone),contact_email=VALUES(contact_email),updated_by_membership_id=VALUES(updated_by_membership_id)',
        [scope.societyId, input.contactPhone, input.contactEmail, scope.membershipId],
      );
      // Record which fields are published, never the contact values themselves.
      await this.property.access.audit(
        db,
        scope,
        'society.applicant_contact_updated',
        'society',
        scope.societyId,
        audit,
        {
          phonePublished: input.contactPhone !== null,
          emailPublished: input.contactEmail !== null,
        },
      );
      return { contactPhone: input.contactPhone, contactEmail: input.contactEmail };
    });
  }

  /** Published contacts for the given societies, keyed by society ID. */
  async forSocieties(
    db: PoolConnection,
    societyIds: string[],
  ): Promise<Map<string, SocietyContact>> {
    if (!societyIds.length) return new Map();
    const found = await rows<ContactRow>(
      db,
      'SELECT society_id,contact_phone,contact_email FROM society_contacts WHERE society_id IN (' +
        societyIds.map(() => '?').join(',') +
        ') AND (contact_phone IS NOT NULL OR contact_email IS NOT NULL)',
      societyIds,
    );
    return new Map(found.map((row) => [String(row.society_id), toContact(row)]));
  }
}
