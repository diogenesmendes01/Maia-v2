import { and } from 'drizzle-orm';
import { entidades } from '../schema.js';
import { TypedError } from '@/lib/utils.js';

export type EntityScope = {
  pessoa_id: string;
  entidades: string[];
};

/**
 * Valid procedure lifecycle statuses. Mirrors ProcedureStatus in
 * procedure-status.ts — duplicated here to avoid a circular import
 * (repositories.ts ← procedure-status.ts already).
 */
export type ProcedureStatus = 'draft' | 'proposed' | 'active' | 'frozen' | 'rolled_back';

/**
 * Thrown by atomicActivate when the locked row's status no longer matches
 * the expected_from_status passed by the caller. Indicates a concurrent
 * write raced ahead — callers should re-fetch and retry if appropriate.
 */
export class OptimisticLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

export class EmptyScopeError extends TypedError {
  constructor() {
    super('empty_scope', 'Repository called without entity scope');
  }
}
