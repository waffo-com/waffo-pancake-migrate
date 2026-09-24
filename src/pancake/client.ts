import { WaffoPancake } from '@waffo/pancake-ts';
import { audit, registerSecret } from '../utils/audit.js';

export function pancakeClient(merchantId: string, privateKey: string) {
  registerSecret(privateKey);
  return new WaffoPancake({ merchantId, privateKey, fetch: async (url, init) => {
    const started = Date.now();
    const path = new URL(String(url)).origin + new URL(String(url)).pathname;
    try {
      const response = await globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      audit('api.response', { merchantId, path, status: response.status, durationMs: Date.now() - started,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? response.headers.get('cf-ray') });
      if (!response.ok) throw new Error(`Pancake HTTP ${response.status}: ${path}`);
      return response;
    } catch (error) {
      audit('api.failed', { merchantId, path, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }});
}

export async function query<T>(client: WaffoPancake, text: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await client.graphql.query<T>({ query: text, variables }) as unknown as T & { data?: T; errors?: unknown[] };
  if (!response || response.errors?.length) throw new Error('Pancake GraphQL query failed');
  return response.data ?? response;
}

export async function readBack<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      audit('verification.retry', { attempt, error: error instanceof Error ? error.message : String(error) });
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 400));
    }
  }
}
