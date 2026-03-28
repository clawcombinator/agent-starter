import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const requiredDocs = ['KILLSWITCH.md', 'THROTTLE.md', 'ESCALATE.md', 'FAILURE.md'] as const;
const requiredWorkflowFiles = [
  'service-delivery.yaml',
  'programme-application.yaml',
  'market-signal-intake.yaml',
] as const;

type GovernanceDocName = typeof requiredDocs[number];

interface WorkflowTemplate {
  workflow_id?: string;
  version?: string;
  governance_documents?: string[];
}

function extractFrontMatter(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, 'utf8');
  if (!content.startsWith('---\n')) {
    throw new Error(`${path.basename(filePath)} is missing YAML front matter`);
  }

  const parts = content.split('---', 3);
  if (parts.length < 3) {
    throw new Error(`${path.basename(filePath)} has malformed YAML front matter`);
  }

  return (parse(parts[1] ?? '') as Record<string, unknown>) ?? {};
}

function validateGovernanceDoc(fileName: GovernanceDocName): string[] {
  const filePath = path.join(rootDir, 'governance', fileName);
  const errors: string[] = [];

  if (!existsSync(filePath)) {
    return [`Missing governance document: governance/${fileName}`];
  }

  try {
    const frontMatter = extractFrontMatter(filePath);
    const expectedType = fileName.replace('.md', '');
    if (frontMatter['document_type'] !== expectedType) {
      errors.push(
        `governance/${fileName} has document_type=${String(frontMatter['document_type'])}, expected ${expectedType}`,
      );
    }
    if (!frontMatter['version']) {
      errors.push(`governance/${fileName} is missing version in front matter`);
    }
  } catch (error) {
    errors.push(String(error));
  }

  return errors;
}

function validateWorkflow(fileName: string): string[] {
  const filePath = path.join(rootDir, 'workflows', fileName);
  const errors: string[] = [];

  if (!existsSync(filePath)) {
    return [`Missing workflow template: workflows/${fileName}`];
  }

  try {
    const workflow = (parse(readFileSync(filePath, 'utf8')) as WorkflowTemplate) ?? {};
    if (!workflow.workflow_id) {
      errors.push(`workflows/${fileName} is missing workflow_id`);
    }
    if (!workflow.version) {
      errors.push(`workflows/${fileName} is missing version`);
    }

    const governanceDocs = new Set(workflow.governance_documents ?? []);
    for (const doc of requiredDocs) {
      if (!governanceDocs.has(doc)) {
        errors.push(`workflows/${fileName} does not reference ${doc}`);
      }
    }
  } catch (error) {
    errors.push(`workflows/${fileName} failed to parse: ${String(error)}`);
  }

  return errors;
}

function main(): void {
  const errors = [
    ...requiredDocs.flatMap(validateGovernanceDoc),
    ...requiredWorkflowFiles.flatMap(validateWorkflow),
  ];

  if (errors.length > 0) {
    console.error('Governance validation failed:\n');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('Governance validation passed.');
  console.log(`Verified governance docs: ${requiredDocs.join(', ')}`);
  console.log(`Verified workflows: ${requiredWorkflowFiles.join(', ')}`);
}

main();
