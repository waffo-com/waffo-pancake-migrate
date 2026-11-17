import { Command, Option } from "commander";
import { confirm } from "@inquirer/prompts";
import {
  startAudit,
  endAudit,
  audit,
  registerSecret,
  redact,
} from "../utils/audit.js";
import {
  prepareTarget,
  showTarget,
  finishMigration,
} from "../utils/migration.js";
import { spinner, stopSpinners } from "../utils/spinner.js";
import { fetchDodoProducts } from "../dodo/fetcher.js";
import { mapDodoProducts } from "../dodo/mapper.js";
import { createPancakeProducts } from "../pancake/creator.js";
import {
  runDodoSourcePrompts,
  runDodoTargetPrompts,
} from "../prompts/interactive.js";
import { renderPreviewTable, renderResultsTable } from "../utils/table.js";
import { log } from "../utils/logger.js";
import type { DodoCommandOptions } from "../utils/types.js";

export function dodoCommand(): Command {
  return new Command("dodo")
    .description("Migrate the Dodo Payments product catalog to Waffo Pancake")
    .option(
      "--api-key <key>",
      "Dodo API key (prefer DODO_PAYMENTS_API_KEY or the hidden prompt)"
    )
    .addOption(
      new Option(
        "--environment <environment>",
        "Dodo source environment (required outside interactive mode)"
      ).choices(["test", "live"])
    )
    .addOption(
      new Option("--merchant-id <id>", "Waffo Pancake Merchant ID").env(
        "WAFFO_MERCHANT_ID"
      )
    )
    .addOption(
      new Option(
        "--private-key <path>",
        "Path to Pancake API private key file"
      ).env("WAFFO_PRIVATE_KEY_PATH")
    )
    .addOption(
      new Option("--store-id <id>", "Target Pancake Store ID or 'new'").env(
        "WAFFO_STORE_ID"
      )
    )
    .option("--store-name <name>", "Name for a new store")
    .option(
      "--store-creation-id <id>",
      "Explicit new-store operation ID; reuse for retries"
    )
    .option("--log-file <path>", "New JSONL audit log path (must not exist)")
    .option("--dry-run", "Preview without destination credentials or writes")
    .option(
      "--acknowledge-tax-semantics",
      "Confirm review of inclusive/unspecified tax behavior in the destination"
    )
    .option(
      "--yes",
      "Skip the final creation confirmation (does not acknowledge tax semantics)"
    )
    .action(async (opts: DodoCommandOptions) => {
      // Empty template values should still trigger the interactive credential prompts.
      opts.merchantId ||= undefined;
      opts.privateKey ||= undefined;
      opts.storeId ||= undefined;
      registerSecret(opts.apiKey ?? process.env.DODO_PAYMENTS_API_KEY);
      registerSecret(opts.privateKey);
      try {
        log.info(`Audit log: ${startAudit(opts.logFile)}`);
        audit("migration.started", {
          source: "dodo",
          merchantId: opts.merchantId,
        });
        await runDodoMigration(opts);
      } catch (error) {
        stopSpinners();
        const message = redact(
          error instanceof Error ? error.message : String(error)
        );
        log.error(message);
        audit("migration.failed", { error: message });
        process.exitCode = 1;
      } finally {
        stopSpinners();
        endAudit();
      }
    });
}

async function runDodoMigration(opts: DodoCommandOptions): Promise<void> {
  if (
    !process.stdin.isTTY &&
    (!opts.environment || !(opts.apiKey ?? process.env.DODO_PAYMENTS_API_KEY))
  ) {
    throw new Error(
      "Non-interactive Dodo migration requires --environment test|live and DODO_PAYMENTS_API_KEY (or --api-key)"
    );
  }
  const source = await runDodoSourcePrompts(opts);
  log.info(
    `Dodo ${source.environment} → Waffo Pancake test versions (not published)`
  );
  const fetching = spinner(
    "Fetching Dodo product pages and full details..."
  ).start();
  const sourceProducts = await fetchDodoProducts(
    source.apiKey,
    source.environment
  );
  fetching.succeed(`Found ${sourceProducts.length} unarchived products`);
  const { products, warnings, skipped } = mapDodoProducts(sourceProducts);
  renderPreviewTable(products, warnings, skipped);
  for (const item of skipped)
    audit("product.skipped", {
      source: "dodo",
      sourceProductId: item.sourceProductId,
      message: item.reason,
    });
  // Make partial catalog migrations detectable by automation, including previews.
  if (skipped.length) process.exitCode = 1;
  if (opts.dryRun) {
    log.info("Dry run complete. No changes were made.");
    return;
  }
  if (!products.length) {
    log.info("No supported products to migrate.");
    return;
  }
  if (
    !opts.acknowledgeTaxSemantics &&
    products.some((p) => p.metadata._dodoTaxInclusive !== false)
  ) {
    throw new Error(
      "Review inclusive/unspecified Dodo tax settings and destination tax behavior, then pass --acknowledge-tax-semantics. No writes made."
    );
  }
  if (
    !process.stdin.isTTY &&
    (!opts.merchantId ||
      !opts.privateKey ||
      !opts.storeId ||
      !opts.yes ||
      (opts.storeId === "new" && !opts.storeName))
  ) {
    throw new Error(
      "Non-interactive writes require --merchant-id, --private-key, --store-id, --yes and --store-name for a new store"
    );
  }
  const target = await runDodoTargetPrompts(opts);
  if (
    target.storeCreationId !== undefined &&
    (target.storeId !== "new" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(target.storeCreationId))
  ) {
    throw new Error(
      "--store-creation-id requires --store-id new and 1-128 letters, numbers, underscores or hyphens"
    );
  }
  if (
    target.storeId === "new" &&
    (!target.storeName?.trim() || target.storeName.trim().length > 48)
  ) {
    throw new Error("--store-id new requires --store-name (1-48 characters)");
  }
  log.info(
    `Target merchant: ${target.merchantId}; store: ${target.storeId === "new" ? target.storeName : target.storeId}`
  );
  if (
    !opts.yes &&
    !(await confirm({
      message: `Create ${products.length} products in this Pancake store?`,
      default: false,
    }))
  ) {
    log.info("Migration cancelled.");
    return;
  }
  target.storeId = await prepareTarget(
    target.merchantId,
    target.privateKey,
    target.storeId,
    target.storeName,
    target.storeCreationId
  );
  showTarget(target.storeId);
  const creating = spinner("Creating products...").start();
  const results = await createPancakeProducts({
    products,
    ...target,
    onProgress: (completed, total) => {
      creating.text = `Creating products... (${completed}/${total})`;
    },
  });
  const failed = results.filter((r) => !r.success).length;
  if (failed) creating.fail("Some products failed creation or verification");
  else creating.succeed("Products created and verified");
  renderResultsTable(results);
  log.info("Dodo → Waffo product ID mapping:");
  for (const result of results) {
    console.log(
      `${result.input.sourceProductId} → ${result.pancakeProductId ?? "(not created)"} [${result.success ? "VERIFIED" : "FAILED/UNVERIFIED"}]`
    );
    audit("dodo.product_mapping", {
      sourceProductId: result.input.sourceProductId,
      productId: result.pancakeProductId,
      verified: result.success,
      storeId: target.storeId,
    });
  }
  finishMigration(failed + skipped.length);
}
