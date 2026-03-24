import crypto from 'node:crypto';
import type {
  AgentCardDocument,
  RequestAuthEnvelope,
  SignedVerificationAttestation,
  VerificationAttestationPayload,
} from './types.js';
import { stableStringify } from './canonical-json.js';

interface UnsignedRequestAuth {
  agent_id: string;
  key_id: string;
  signed_at: string;
}

export function generateEd25519KeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

export function signStructuredPayload(payload: unknown, privateKeyPem: string): string {
  return crypto.sign(
    null,
    Buffer.from(stableStringify(payload), 'utf8'),
    privateKeyPem,
  ).toString('base64');
}

export function verifyStructuredPayload(
  payload: unknown,
  publicKeyPem: string,
  signature: string,
): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(stableStringify(payload), 'utf8'),
      publicKeyPem,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function buildAgentCardSignaturePayload(agentCard: AgentCardDocument): Record<string, unknown> {
  return {
    type: 'agent_card_registration',
    agent_card: agentCard,
  };
}

export function buildToolRequestSignaturePayload(
  toolName: string,
  args: Record<string, unknown>,
  auth: UnsignedRequestAuth,
): Record<string, unknown> {
  const { auth: _auth, ...rest } = stripAuthFromArgs(args);
  return {
    type: 'mcp_mutation',
    tool_name: toolName,
    auth,
    args: rest,
  };
}

export function signToolRequest(
  toolName: string,
  args: Record<string, unknown>,
  agentId: string,
  keyId: string,
  privateKeyPem: string,
  signedAt: string = new Date().toISOString(),
): RequestAuthEnvelope {
  const unsigned = {
    agent_id: agentId,
    key_id: keyId,
    signed_at: signedAt,
  };
  return {
    ...unsigned,
    signature: signStructuredPayload(
      buildToolRequestSignaturePayload(toolName, args, unsigned),
      privateKeyPem,
    ),
  };
}

export function stripAuthFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(args) as Record<string, unknown>;
  if (clone['auth'] && typeof clone['auth'] === 'object') {
    const authRecord = clone['auth'] as Record<string, unknown>;
    const nextAuth: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(authRecord)) {
      if (key === 'signature' || key === 'signed_at') {
        continue;
      }
      nextAuth[key] = value;
    }
    clone['auth'] = nextAuth;
  }
  return clone;
}

export function verifyAgentRegistrationSignature(
  agentCard: AgentCardDocument,
  signature: string,
): { keyId: string; publicKeyPem: string } | undefined {
  for (const signingKey of agentCard.auth.signing_keys) {
    if (verifyStructuredPayload(
      buildAgentCardSignaturePayload(agentCard),
      signingKey.public_key_pem,
      signature,
    )) {
      return {
        keyId: signingKey.key_id,
        publicKeyPem: signingKey.public_key_pem,
      };
    }
  }
  return undefined;
}

export function buildVerificationAttestationSignaturePayload(
  attestation: Omit<SignedVerificationAttestation, 'signature'>,
): Record<string, unknown> {
  return {
    type: 'verification_attestation',
    attestation_id: attestation.attestation_id,
    verifier_id: attestation.verifier_id,
    key_id: attestation.key_id,
    algorithm: attestation.algorithm,
    signed_at: attestation.signed_at,
    payload: attestation.payload,
  };
}

export function signVerificationAttestation(
  verifierId: string,
  keyId: string,
  payload: VerificationAttestationPayload,
  privateKeyPem: string,
  signedAt: string = new Date().toISOString(),
): SignedVerificationAttestation {
  const unsigned = {
    attestation_id: `attest_${crypto.randomBytes(8).toString('hex')}`,
    verifier_id: verifierId,
    key_id: keyId,
    algorithm: 'ed25519' as const,
    signed_at: signedAt,
    payload,
  };

  return {
    ...unsigned,
    signature: signStructuredPayload(
      buildVerificationAttestationSignaturePayload(unsigned),
      privateKeyPem,
    ),
  };
}

export function verifyVerificationAttestation(
  attestation: SignedVerificationAttestation,
  publicKeyPem: string,
): boolean {
  const { signature, ...unsigned } = attestation;
  return verifyStructuredPayload(
    buildVerificationAttestationSignaturePayload(unsigned),
    publicKeyPem,
    signature,
  );
}

