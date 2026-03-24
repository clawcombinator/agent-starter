import { Ajv, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  OutputContractDocument,
  OutputContractValidationResult,
  VerificationStatus,
} from './types.js';
import { sha256Hex } from './canonical-json.js';

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
  const material = {
    contract_id: contract.contract_id,
    spec_version: contract.spec_version,
    payload,
  };

  return `sha256:${sha256Hex(material)}`;
}

export function hashOutputContract(contract: OutputContractDocument): string {
  return sha256Hex({
    contract_id: contract.contract_id,
    name: contract.name,
    spec_version: contract.spec_version,
    workflow_class: contract.workflow_class,
    input_type: contract.input_type,
    output_type: contract.output_type,
    verification_tier: contract.verification_tier,
    deliverable_schema: contract.deliverable_schema,
    settlement_rules: contract.settlement_rules,
    example_subject_ref: contract.example_subject_ref ?? null,
  });
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
