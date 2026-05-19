/**
 * P10a — decideInitialStatus() rules (master §2.6 + §11.3.3).
 *
 * Pure function; tests are exhaustive over the input matrix.
 */

import { describe, expect, it } from 'vitest';
import { decideInitialStatus } from '@/control-plane/knowledge-state-machine/state-machine.js';
import type {
  KnowledgeKind,
  KnowledgeRiskLevel,
  KnowledgeSensitivity,
} from '@/control-plane/knowledge-state-machine/types.js';

const RISKS: KnowledgeRiskLevel[] = ['low', 'medium', 'high', 'critical'];
const KINDS_NON_RULE: KnowledgeKind[] = [
  'fact',
  'memory',
  'behavioral_hint',
  'procedure_hint',
];

describe('P10a decideInitialStatus — kind=rule always pending_review', () => {
  it('returns pending_review regardless of risk, confidence, sensitivity', () => {
    for (const risk of RISKS) {
      for (const sensitivity of ['low', 'medium', 'high'] as KnowledgeSensitivity[]) {
        for (const conf of [0.1, 0.4, 0.5, 0.6, 0.9, 0.99, 1.0]) {
          const out = decideInitialStatus({
            kind: 'rule',
            risk_level: risk,
            sensitivity,
            confidence: conf,
          });
          expect(out).toBe('pending_review');
        }
      }
    }
  });
});

describe('P10a decideInitialStatus — risk=high or critical always pending_review', () => {
  it('routes high to pending_review for non-rule kinds', () => {
    for (const kind of KINDS_NON_RULE) {
      const out = decideInitialStatus({
        kind,
        risk_level: 'high',
        sensitivity: 'low',
        confidence: 1.0,
      });
      expect(out).toBe('pending_review');
    }
  });

  it('routes critical to pending_review for non-rule kinds', () => {
    for (const kind of KINDS_NON_RULE) {
      const out = decideInitialStatus({
        kind,
        risk_level: 'critical',
        sensitivity: 'low',
        confidence: 1.0,
      });
      expect(out).toBe('pending_review');
    }
  });
});

describe('P10a decideInitialStatus — sensitivity=high routes to pending_review', () => {
  it('sensitivity=high overrides low risk', () => {
    for (const kind of KINDS_NON_RULE) {
      const out = decideInitialStatus({
        kind,
        risk_level: 'low',
        sensitivity: 'high',
        confidence: 0.9,
      });
      expect(out).toBe('pending_review');
    }
  });
});

describe('P10a decideInitialStatus — risk=medium routes to pending_review', () => {
  it('routes medium to pending_review for non-rule kinds', () => {
    for (const kind of KINDS_NON_RULE) {
      const out = decideInitialStatus({
        kind,
        risk_level: 'medium',
        sensitivity: 'low',
        confidence: 0.99,
      });
      expect(out).toBe('pending_review');
    }
  });
});

describe('P10a decideInitialStatus — risk=low + conf>=0.6 + non-rule routes to ephemeral', () => {
  it('exact boundary conf=0.6 still routes to ephemeral', () => {
    for (const kind of KINDS_NON_RULE) {
      const out = decideInitialStatus({
        kind,
        risk_level: 'low',
        sensitivity: 'low',
        confidence: 0.6,
      });
      expect(out).toBe('ephemeral');
    }
  });

  it('high confidence routes to ephemeral for non-rule kinds', () => {
    for (const kind of KINDS_NON_RULE) {
      for (const conf of [0.6, 0.7, 0.8, 0.9, 0.99, 1.0]) {
        const out = decideInitialStatus({
          kind,
          risk_level: 'low',
          sensitivity: 'low',
          confidence: conf,
        });
        expect(out).toBe('ephemeral');
      }
    }
  });

  it('sensitivity=medium with low risk still routes to ephemeral', () => {
    // sensitivity=high is the only level that elevates; medium does not.
    const out = decideInitialStatus({
      kind: 'fact',
      risk_level: 'low',
      sensitivity: 'medium',
      confidence: 0.7,
    });
    expect(out).toBe('ephemeral');
  });
});

describe('P10a decideInitialStatus — default fallback is pending_review', () => {
  it('low risk + low conf (<0.6) routes to pending_review', () => {
    for (const kind of KINDS_NON_RULE) {
      for (const conf of [0.0, 0.1, 0.4, 0.59, 0.5999]) {
        const out = decideInitialStatus({
          kind,
          risk_level: 'low',
          sensitivity: 'low',
          confidence: conf,
        });
        expect(out).toBe('pending_review');
      }
    }
  });
});

describe('P10a decideInitialStatus — rule check has priority over everything', () => {
  it('rule + low risk + high conf still pending_review', () => {
    const out = decideInitialStatus({
      kind: 'rule',
      risk_level: 'low',
      sensitivity: 'low',
      confidence: 0.99,
    });
    expect(out).toBe('pending_review');
  });
});
