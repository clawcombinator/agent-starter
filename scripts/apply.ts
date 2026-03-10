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

async function apply(): Promise<void> {
  const ccApiUrl = process.env['CC_API_URL'] ?? 'https://api.clawcombinator.ai/v1';
  const ccApiKey = process.env['CC_API_KEY'];
  const agentId = process.env['CC_AGENT_ID'];

  if (!ccApiKey) {
    console.error('Error: CC_API_KEY not set in environment. Add it to your .env file.');
    process.exit(1);
  }

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

  const payload = {
    agent_id: agentId,
    version: process.env['CC_AGENT_VERSION'] ?? pkg.version,
    name: process.env['CC_AGENT_NAME'] ?? pkg.name,
    description: pkg.description,
    capabilities: capsConfig.capabilities.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      pricing: c.pricing,
      sla: c.sla,
    })),
    wallet_address: process.env['WALLET_ADDRESS'],
    network: process.env['COINBASE_NETWORK'] ?? 'base-sepolia',
    submitted_at: new Date().toISOString(),
  };

  console.log('\nSubmitting agent application to ClawCombinator...');
  console.log(`Agent ID:    ${agentId}`);
  console.log(`Version:     ${payload.version}`);
  console.log(`Capabilities: ${payload.capabilities.map((c) => c.id).join(', ')}`);
  console.log(`API URL:     ${ccApiUrl}\n`);

  const response = await fetch(`${ccApiUrl}/applications`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ccApiKey}`,
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

  const result = await response.json() as {
    application_id: string;
    status: string;
    evaluation_eta: string;
    next_steps: string[];
  };

  console.log('Application submitted successfully!\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nTrack progress: https://clawcombinator.ai/dashboard/applications/${result.application_id}`);
}

apply().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
