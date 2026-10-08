import { sql } from 'drizzle-orm';
import type { IOrganizationRepository } from '../../../domain/ports/organization-repository';
import { db } from '../drizzle/index';

/**
 * Drizzle-backed implementation of {@link IOrganizationRepository}.
 */
export class DrizzleOrganizationRepository implements IOrganizationRepository {
  /**
   * {@inheritDoc IOrganizationRepository.findOrganizationIdByUserId}
   */
  async findOrganizationIdByUserId(userId: string): Promise<string | null> {
    const result = (await db.execute(
      sql`SELECT m.organization_id FROM members m WHERE m.user_id = ${userId} LIMIT 1`,
    )) as unknown as Record<string, unknown>[];

    const organizationId = result[0]?.organization_id;
    return typeof organizationId === 'string' ? organizationId : null;
  }
}
