import { describe, expect, it } from 'vitest';
import {
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
  PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
} from '../src/reference-examples.js';
import {
  settlementStatusAllowed,
  validateStructuredDeliverable,
} from '../src/output-contracts.js';

describe('output-contract validation', () => {
  it('validates a structured deliverable against the canonical replayable-test contract', () => {
    const result = validateStructuredDeliverable(
      PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
      PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.evidenceRef).toMatch(/^sha256:/);
  });

  it('rejects a deliverable that violates the contract schema', () => {
    const invalidDeliverable = {
      ...PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE,
      recommendation: 'ship-immediately',
      scenarios: PROJECT_BIRCH_FINANCIAL_ANALYSIS_DELIVERABLE.scenarios.slice(0, 2),
    };

    const result = validateStructuredDeliverable(
      PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
      invalidDeliverable,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.evidenceRef).toMatch(/^sha256:/);
  });

  it('only allows settlement for statuses listed in settlement_rules', () => {
    expect(
      settlementStatusAllowed(
        PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
        'validated',
      ),
    ).toBe(true);

    expect(
      settlementStatusAllowed(
        PROJECT_BIRCH_FINANCIAL_ANALYSIS_CONTRACT,
        'rejected',
      ),
    ).toBe(false);
  });
});
