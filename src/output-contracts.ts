import crypto from 'node:crypto';
import { Ajv, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  OutputContractDocument,
  OutputContractValidationResult,
  VerificationStatus,
} from './types.js';

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
});

(
  addFormats as unknown as (instance: Ajv) => void
)(ajv);

export function validateStructuredDeliverable(
  contract: OutputContractDocument,
  payload: unknown,
): OutputContractValidationResult {
  const validate = ajv.compile(contract.deliverable_schema);
  const valid = validate(payload);
  const errors = valid ? [] : formatErrors(validate.errors ?? []);

  return {
    valid: Boolean(valid),
    errors,
    evidenceRef: buildEvidenceRef(contract, payload),
  };
}

export function buildEvidenceRef(
  contract: Pick<OutputContractDocument, 'contract_id' | 'spec_version'>,
  payload: unknown,
): string {
  const material = stableStringify({
    contract_id: contract.contract_id,
    spec_version: contract.spec_version,
    payload,
  });

  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

export function settlementStatusAllowed(
  contract: OutputContractDocument,
  status: VerificationStatus,
): boolean {
  return contract.settlement_rules.required_verification_statuses.includes(status);
}

function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath || '/';
    if (error.message) {
      return `${path} ${error.message}`;
    }
    return `${path} validation failed`;
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${pairs.join(',')}}`;
}
