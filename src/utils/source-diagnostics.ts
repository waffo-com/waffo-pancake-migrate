import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { audit } from './audit.js';
import pkg from '../../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);
export function sdkVersion(name: string): string {
  try {
    let directory = dirname(require.resolve(name));
    while (true) {
      try {
        const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (metadata.name === name) return metadata.version;
      } catch { /* Continue to the package root. */ }
      const parent = dirname(directory);
      if (parent === directory) return 'unknown';
      directory = parent;
    }
  } catch { return 'unknown'; }
}
export function sourceStarted(source: string, step: string) {
  audit('source.started', { source, step, sdkVersion: sdkVersion(source), toolVersion: pkg.version, nodeVersion: process.version });
}
// Never copy SDK error messages: some contain the entire response body.
export async function sourceStep<T>(source: string, step: string, operation: () => Promise<T>): Promise<T> {
  sourceStarted(source, step);
  const started = Date.now();
  try {
    const result = await operation();
    audit('source.completed', { source, step, durationMs: Date.now() - started, count: Array.isArray(result) ? result.length : undefined });
    return result;
  } catch (error) {
    const e = error as { statusCode?: unknown; status?: unknown; code?: unknown; name?: unknown; requestId?: unknown; cause?: {code?:unknown} } | null;
    const status = typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined;
    const code = typeof e?.code === 'string' ? e.code : e?.cause?.code;
    const category = error instanceof SourceShapeError || /validation/i.test(String(e?.name)) ? 'response_shape'
      : status === 401 || status === 403 ? 'authentication_or_permission'
      : status === 429 ? 'rate_limit'
      : status ? 'http'
      : /timeout/i.test(String(e?.name)) ? 'timeout'
      : /connection|fetch/i.test(String(e?.name)) || typeof code === 'string' && /^(ECONN|ENOTFOUND|ETIMEDOUT)/.test(code) ? 'network' : 'sdk_or_network';
    audit('source.failed', { source, step, status, category, durationMs: Date.now() - started,
      code: typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : undefined,
      requestId: typeof e?.requestId === 'string' ? e.requestId : undefined });
    throw new Error(`${source}: ${step} failed (${category}${status ? `, HTTP ${status}` : ''}). See the audit log for request and SDK details.`);
  }
}
export class SourceShapeError extends Error {}
const kind = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export function recordCreemShape(value: unknown, page: number): void {
  const result = value as {items?:unknown; pagination?:unknown; result?:unknown; next?:unknown} | null;
  audit('source.response_shape', { source: 'creem', step: 'products', page,
    responseShape: `root:${kind(value)},items:${kind(result?.items)},pagination:${kind(result?.pagination)},result:${kind(result?.result)},next:${kind(result?.next)}` });
}
export function validateCreemPage(value: unknown, page: number): void {
  const result = value as {items?:unknown; pagination?:{nextPage?:unknown}; result?:unknown; next?:unknown} | null;
  audit('source.page', { source: 'creem', step: 'products', page,
    responseShape: `root:${kind(value)},items:${kind(result?.items)},pagination:${kind(result?.pagination)},nextPage:${kind(result?.pagination?.nextPage)},result:${kind(result?.result)},next:${kind(result?.next)}`,
    count: Array.isArray(result?.items) ? result.items.length : undefined });
  const next = result?.pagination?.nextPage;
  if (!Array.isArray(result?.items) || !result?.pagination || !(next === null || typeof next === 'number' && Number.isInteger(next) && next > page)) {
    throw new SourceShapeError('Expected items array and pagination with a forward nextPage or null');
  }
}
