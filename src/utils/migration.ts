import { confirm } from "@inquirer/prompts";
import { createPancakeStore, verifyPancakeStore } from "../pancake/creator.js";
import { audit } from "./audit.js";
import { log } from "./logger.js";

export async function prepareTarget(
  merchantId: string,
  privateKey: string,
  storeId: string,
  name?: string,
  storeCreationId?: string
) {
  if (storeId === "new") {
    if (!name?.trim() || name.trim().length > 48)
      throw new Error("New store name must contain 1-48 characters");
    const store = await createPancakeStore(
      merchantId,
      privateKey,
      name.trim(),
      storeCreationId
    );
    log.success(`Store created and verified: ${store.name} (${store.id})`);
    return store.id;
  }
  const store = await verifyPancakeStore(merchantId, privateKey, storeId);
  log.success(`Target store verified: ${store.name} (${store.id})`);
  return store.id;
}
export function showTarget(storeId: string) {
  log.info(
    `Dashboard: https://pancake.waffo.ai/merchant/dashboard/${storeId}/products`
  );
  log.info(
    "Created products are test versions. Publishing to production is a separate action."
  );
}
export function finishMigration(failed: number, skipped = 0) {
  audit("migration.finished", { failed, count: skipped });
  if (failed) {
    log.error(
      `Migration incomplete: ${failed} operation(s) failed or could not be verified${skipped ? `, and ${skipped} item(s) were skipped` : ""}. See the audit log; do not rerun blindly.`
    );
    process.exitCode = 1;
  } else if (skipped) {
    log.warn(
      `Migration finished with ${skipped} skipped item(s) (see the preview for reasons). Everything else was created and verified.`
    );
    process.exitCode = 1;
  } else
    log.success(
      "Migration complete. All requested operations succeeded; product read-back checks passed."
    );
}

/**
 * Tax-inclusive behavior is not configured by this tool, so writes need an explicit
 * acknowledgement: the flag in scripts, or a confirmation prompt in a terminal.
 * `--yes` never counts as this acknowledgement.
 */
export async function ensureTaxAcknowledged(
  source: string,
  acknowledged: boolean | undefined,
  error: string,
  {
    interactive = Boolean(process.stdin.isTTY),
    ask = (message: string) => confirm({ message, default: false }),
  }: {
    interactive?: boolean;
    ask?: (message: string) => Promise<boolean>;
  } = {}
): Promise<boolean> {
  if (acknowledged) {
    audit("tax_semantics.acknowledged", { source, step: "flag" });
    return true;
  }
  if (!interactive) throw new Error(error);
  log.warn(error.replace(/,? then pass --acknowledge-tax-semantics\. No writes made\.$/, "."));
  const confirmed = await ask(
    "I reviewed the destination tax behavior; this tool does not configure tax-inclusive pricing in Waffo. Continue?"
  );
  if (!confirmed) {
    log.info("Migration cancelled. No writes made.");
    return false;
  }
  audit("tax_semantics.acknowledged", { source, step: "prompt" });
  return true;
}
