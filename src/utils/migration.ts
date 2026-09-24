import { createPancakeStore, verifyPancakeStore } from '../pancake/creator.js';
import { audit } from './audit.js';
import { log } from './logger.js';

export async function prepareTarget(merchantId: string, privateKey: string, storeId: string, name?: string) {
  if (storeId === 'new') {
    if (!name?.trim() || name.trim().length > 48) throw new Error('New store name must contain 1-48 characters');
    const store = await createPancakeStore(merchantId, privateKey, name.trim());
    log.success(`Store created and verified: ${store.name} (${store.id})`);
    return store.id;
  }
  const store = await verifyPancakeStore(merchantId, privateKey, storeId);
  log.success(`Target store verified: ${store.name} (${store.id})`);
  return store.id;
}
export function showTarget(storeId: string) {
  log.info(`Dashboard: https://pancake.waffo.ai/merchant/dashboard/${storeId}/products`);
  log.info('Created products are test versions. Publishing to production is a separate action.');
}
export function finishMigration(failed: number) {
  audit('migration.finished', { failed });
  if (failed) {
    log.error(`Migration incomplete: ${failed} operation(s) failed or could not be verified. See the audit log; do not rerun blindly.`);
    process.exitCode = 1;
  } else log.success('Migration complete. All requested operations succeeded; product read-back checks passed.');
}
