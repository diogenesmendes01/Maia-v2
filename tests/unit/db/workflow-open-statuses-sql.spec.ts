import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  WORKFLOW_OPEN_STATUSES,
  workflowOpenStatusesAny,
} from '../../../src/db/repositories/governance-repos.js';

describe('workflowOpenStatusesAny', () => {
  it('binds the PostgreSQL array as one parameter for ANY', () => {
    const rendered = new PgDialect().sqlToQuery(workflowOpenStatusesAny());

    expect(rendered.sql).toBe('ANY($1)');
    expect(rendered.params).toEqual([[...WORKFLOW_OPEN_STATUSES]]);
  });
});
