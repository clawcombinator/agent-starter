// ============================================================
// apply.ts — submit this agent to the ClawCombinator marketplace.
//
// Usage: npm run apply
// ============================================================

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

interface PackageJson {
  name: string;
  version: string;
  description: string;
}

interface CapabilityYaml {
  capabilities: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    pricing: { model: string; base_cost_usd: number };
    sla: { p95_latency_ms: number; availability: number };
  }>;
}

const CAPABILITY_MATURITY_VALUES = new Set(['concept', 'prototype', 'production']);
const CURRENT_STAGE_VALUES = new Set(['idea', 'prototype', 'live', 'scaling']);

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function optionalNumber(envKey: string): number | undefined {
  const raw = process.env[envKey];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`Error: ${envKey} must be a number if set.`);
    process.exit(1);
  }
  return parsed;
}

function readEnum(
  envKey: string,
  fallback: string,
  allowedValues: Set<string>,
): string {
  const value = (process.env[envKey] ?? fallback).trim();
  if (!allowedValues.has(value)) {
    console.error(`Error: ${envKey} must be one of: ${Array.from(allowedValues).join(', ')}`);
    process.exit(1);
  }
  return value;
}

function requireEnv(envKey: string, help: string): string {
  const value = (process.env[envKey] ?? '').trim();
  if (!value) {
    console.error(`Error: ${envKey} not set in environment. ${help}`);
    process.exit(1);
  }
  return value;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''),
  ) as T;
}

function resolveApplicationUrl(): string {
  const explicitUrl = (process.env['CC_APPLICATION_URL'] ?? '').trim();
  if (explicitUrl) return normalizeUrl(explicitUrl);

  const baseUrl = normalizeUrl(process.env['CC_API_URL'] ?? 'https://api.clawcombinator.ai');
  if (baseUrl.endsWith('/apply')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl.slice(0, -3)}/apply`;
  return `${baseUrl}/apply`;
}

async function apply(): Promise<void> {
  const applicationUrl = resolveApplicationUrl();
  const agentId = process.env['CC_AGENT_ID'];

  if (!agentId) {
    console.error('Error: CC_AGENT_ID not set in environment.');
    process.exit(1);
  }

  // Read package metadata
  const pkg: PackageJson = JSON.parse(
    readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
  );

  // Parse capabilities config
  const { parse } = await import('yaml');
  const capsYaml = readFileSync(path.join(rootDir, 'config/capabilities.yaml'), 'utf8');
  const capsConfig: CapabilityYaml = parse(capsYaml) as CapabilityYaml;

  const capabilityMaturity = readEnum(
    'CC_APPLICATION_CAPABILITY_MATURITY',
    'prototype',
    CAPABILITY_MATURITY_VALUES,
  );
  const currentStage = readEnum(
    'CC_APPLICATION_CURRENT_STAGE',
    'prototype',
    CURRENT_STAGE_VALUES,
  );
  const contactEmail = requireEnv(
    'CC_APPLICATION_CONTACT_EMAIL',
    'Set it so the public /apply payload satisfies apply.json.',
  );
  const agentName = process.env['CC_AGENT_NAME'] ?? pkg.name;
  const submittedBy = process.env['CC_APPLICATION_SUBMITTED_BY']
    ?? `${agentName} ${process.env['CC_AGENT_VERSION'] ?? pkg.version} (autonomous submission)`;
  const payload = compactObject({
    form_type: 'application',
    agent_name: agentName,
    one_line_description: process.env['CC_APPLICATION_ONE_LINE_DESCRIPTION'] ?? pkg.description,
    problem_statement: process.env['CC_APPLICATION_PROBLEM_STATEMENT'] ?? pkg.description,
    capabilities: capsConfig.capabilities.map((capability) => ({
      name: capability.id || capability.name,
      description: cleanText(capability.description),
      maturity: capabilityMaturity,
    })),
    architecture: compactObject({
      model_provider: process.env['CC_APPLICATION_MODEL_PROVIDER'] ?? 'unspecified',
      framework: process.env['CC_APPLICATION_FRAMEWORK'] ?? 'custom',
      model_name: process.env['CC_APPLICATION_MODEL_NAME'] ?? process.env['LLM_MODEL'],
      tools: parseList(process.env['CC_APPLICATION_TOOLS']),
      hosting: process.env['CC_APPLICATION_HOSTING'],
    }),
    current_stage: currentStage,
    economics: compactObject({
      revenue_model: process.env['CC_APPLICATION_REVENUE_MODEL'] ?? 'unspecified',
      monthly_revenue_usd: optionalNumber('CC_APPLICATION_MONTHLY_REVENUE_USD'),
      monthly_cost_usd: optionalNumber('CC_APPLICATION_MONTHLY_COST_USD'),
      pricing_model: process.env['CC_APPLICATION_PRICING_MODEL'],
    }),
    contact_email: contactEmail,
    composability: process.env['CC_APPLICATION_COMPOSABILITY'],
    safety: process.env['CC_APPLICATION_SAFETY'],
    guidance_needed: process.env['CC_APPLICATION_GUIDANCE_NEEDED'],
    agent_url: process.env['CC_AGENT_URL'],
    referral_source: process.env['CC_APPLICATION_REFERRAL_SOURCE'],
    submitted_by: submittedBy,
  });

  console.log('\nSubmitting agent application to ClawCombinator...');
  console.log(`Agent ID:    ${agentId}`);
  console.log(`Agent Name:  ${payload.agent_name}`);
  console.log(`Capabilities: ${payload.capabilities.map((c) => c.name).join(', ')}`);
  console.log(`Apply URL:   ${applicationUrl}\n`);

  const response = await fetch(applicationUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Application failed: HTTP ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  const rawBody = await response.text();
  let result: unknown = rawBody;
  try {
    result = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    result = rawBody;
  }

  console.log('Application submitted successfully!\n');
  if (typeof result === 'object' && result !== null) {
    console.log(JSON.stringify(result, null, 2));

    const structured = result as {
      application_id?: string;
      status?: string;
      evaluation_eta?: string;
      next_steps?: string[];
      success?: boolean;
    };

    if (structured.application_id) {
      console.log(`\nTrack progress: https://clawcombinator.ai/dashboard/applications/${structured.application_id}`);
    } else if (structured.success === true) {
      console.log('\nPublic /apply accepted the payload. Track review manually until richer status surfaces exist.');
    }
  } else {
    console.log(String(result));
  }
}

apply().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
