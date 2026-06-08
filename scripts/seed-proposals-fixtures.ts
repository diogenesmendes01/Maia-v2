/**
 * P8.5 — seed fixtures for admin-ui E2E tests.
 *
 * Inserts test rows into:
 *   - app_users (one per role: founder, owner, compliance_officer, analyst, viewer)
 *   - capability_proposals (3 low + 2 medium + 1 high)
 *
 * Idempotent: safe to re-run; uses ON CONFLICT DO NOTHING.
 *
 * Usage: `npx tsx scripts/seed-proposals-fixtures.ts`
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import {
  app_users,
  capability_proposals,
} from '../src/db/schema.js';

async function main() {
  const tenantId = 'test-tenant';

  // Users — one per role
  const users = [
    { id: 'user-founder', role: 'founder', email: 'founder@maia.test' },
    { id: 'user-owner', role: 'owner', email: 'owner@maia.test' },
    { id: 'user-compliance', role: 'compliance_officer', email: 'compliance@maia.test' },
    { id: 'user-analyst', role: 'analyst', email: 'analyst@maia.test' },
    { id: 'user-viewer', role: 'viewer', email: 'viewer@maia.test' },
  ];

  for (const u of users) {
    await db
      .insert(app_users)
      .values({ id: u.id, tenant_id: tenantId, email: u.email, role: u.role, name: u.role })
      .onConflictDoNothing();
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${users.length} users for tenant=${tenantId}`);

  // capability_proposals — mix of risk levels (proxy: status=submitted ⇒ "proposed" in admin-ui)
  const proposals = [
    {
      id: '00000000-0000-0000-0000-000000000001',
      title: 'Email drafting tool',
      capability_type: 'tool',
      description: 'Allow agent to draft emails on the user behalf.',
      motivation: 'Reduces user back-and-forth.',
      expected_impact: 'medium',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      title: 'OFX importer',
      capability_type: 'tool',
      description: 'Parse OFX banking exports.',
      motivation: 'User asked 3 times last month.',
      expected_impact: 'high',
    },
    {
      id: '00000000-0000-0000-0000-000000000003',
      title: 'Calendar integration',
      capability_type: 'integration',
      description: 'Two-way sync with Google Calendar.',
      motivation: 'High-frequency request.',
      expected_impact: 'high',
    },
  ];

  for (const p of proposals) {
    await db
      .insert(capability_proposals)
      .values({
        id: p.id,
        tenant_id: tenantId,
        // issue #323: the 'default' agent was eliminated; reference the reserved
        // 'primary' agent (the only seeded agent post-migration).
        agent_id: 'primary',
        capability_type: p.capability_type,
        title: p.title,
        description: p.description,
        motivation: p.motivation,
        expected_impact: p.expected_impact,
        status: 'submitted',
      })
      .onConflictDoNothing();
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${proposals.length} capability_proposals (status=submitted)`);

  // eslint-disable-next-line no-console
  console.log('P8.5 seed fixtures applied.');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
