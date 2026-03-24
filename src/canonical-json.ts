import crypto from 'node:crypto';

export function stableStringify(value: unknown): string {
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

export function sha256Hex(value: unknown): string {
  const material = typeof value === 'string' ? value : stableStringify(value);
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

