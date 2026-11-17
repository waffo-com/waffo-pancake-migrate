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
import {
  fetchLemonSqueezyCatalog,
  fetchLemonSqueezyStores,
  type LemonSqueezyCatalog,
  type LemonSqueezyStore,
} from "../lemonsqueezy/fetcher.js";
import {
  mapLemonSqueezyDiscounts,
  mapLemonSqueezyProducts,
} from "../lemonsqueezy/mapper.js";
import { createPancakeProducts } from "../pancake/creator.js";
import { createPancakeCoupons } from "../pancake/coupons.js";
import {
  runLemonSqueezyKeyPrompt,
  runLemonSqueezyTargetPrompts,
  selectLemonSqueezyStore,
} from "../prompts/interactive.js";
import {
  renderCouponPreviewTable,
  renderCouponResultsTable,
  renderPreviewTable,
  renderResultsTable,
} from "../utils/table.js";
import { log } from "../utils/logger.js";
import type { LemonSqueezyCommandOptions } from "../utils/types.js";

export function lemonSqueezyCommand(): Command {
  return new Command("lemonsqueezy")
    .alias("lemon-squeezy")
    .description(
      "Migrate the Lemon Squeezy product catalog and discount codes to Waffo Pancake"
    )
    .option(
      "--api-key <key>",
      "Lemon Squeezy API key (prefer LEMONSQUEEZY_API_KEY or the hidden prompt)"
    )
    .option(
      "--ls-store-id <id>",
      "Lemon Squeezy store ID (required when the key can access several stores)"
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
    .option("--skip-discounts", "Migrate products only")
    .option("--log-file <path>", "New JSONL audit log path (must not exist)")
    .option("--dry-run", "Preview without destination credentials or writes")
    .option(
      "--acknowledge-tax-semantics",
      "Confirm review of tax-inclusive pricing behavior in the destination"
    )
    .option(
      "--yes",
      "Skip the final creation confirmation (does not acknowledge tax semantics)"
    )
    .action(async (opts: LemonSqueezyCommandOptions) => {
      // Empty template values should still trigger the interactive credential prompts.
      opts.merchantId ||= undefined;
      opts.privateKey ||= undefined;
      opts.storeId ||= undefined;
      registerSecret(opts.apiKey ?? process.env.LEMONSQUEEZY_API_KEY);
      registerSecret(opts.privateKey);
      try {
        log.info(`Audit log: ${startAudit(opts.logFile)}`);
        audit("migration.started", {
          source: "lemonsqueezy",
          merchantId: opts.merchantId,
        });
        await runLemonSqueezyMigration(opts);
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

async function chooseStore(
  stores: LemonSqueezyStore[],
  requested?: string
): Promise<LemonSqueezyStore> {
  if (requested) {
    const store = stores.find((s) => s.id === requested);
    if (!store)
      throw new Error(
        `Lemon Squeezy store ${requested} is not accessible with this API key`
      );
    return store;
  }
  if (stores.length === 0)
    throw new Error("This Lemon Squeezy API key has no accessible stores");
  if (stores.length === 1) return stores[0];
  if (!process.stdin.isTTY)
    throw new Error(
      `This API key can access ${stores.length} Lemon Squeezy stores; pass --ls-store-id`
    );
  return selectLemonSqueezyStore(stores);
}

/** Test and live data are separated by the API key; report what the key returned. */
function sourceMode(catalog: LemonSqueezyCatalog): string {
  const modes = new Set(
    [...catalog.products, ...catalog.discounts].map((item) => item.test_mode)
  );
  if (modes.size !== 1) return modes.size ? "mixed" : "unknown";
  return modes.has(true) ? "test mode" : "live mode";
}

async function runLemonSqueezyMigration(
  opts: LemonSqueezyCommandOptions
): Promise<void> {
  if (
    !process.stdin.isTTY &&
    !(opts.apiKey ?? process.env.LEMONSQUEEZY_API_KEY)
  )
    throw new Error(
      "Non-interactive Lemon Squeezy migration requires LEMONSQUEEZY_API_KEY (or --api-key)"
    );
  const apiKey = await runLemonSqueezyKeyPrompt(opts);
  const fetching = spinner("Fetching Lemon Squeezy stores...").start();
  const store = await chooseStore(
    await fetchLemonSqueezyStores(apiKey),
    opts.lsStoreId
  );
  fetching.text = `Fetching products, variants, prices${opts.skipDiscounts ? "" : " and discounts"} of ${store.name}...`;
  const catalog = await fetchLemonSqueezyCatalog(apiKey, store, {
    discounts: !opts.skipDiscounts,
  });
  fetching.succeed(
    `Found ${catalog.products.length} products${opts.skipDiscounts ? "" : ` and ${catalog.discounts.length} discounts`} in ${store.name} (${store.id}, ${store.currency})`
  );
  log.info(
    `Lemon Squeezy ${sourceMode(catalog)} → Waffo Pancake test versions (not published)`
  );

  const { products, warnings, skipped } = mapLemonSqueezyProducts(catalog);
  renderPreviewTable(products, warnings, skipped);
  const coupons = mapLemonSqueezyDiscounts(catalog, products);
  if (!opts.skipDiscounts) renderCouponPreviewTable(coupons);
  for (const item of skipped)
    audit("product.skipped", {
      source: "lemonsqueezy",
      sourceProductId: item.sourceProductId,
      message: item.reason,
    });
  for (const item of coupons.skipped)
    audit("coupon.skipped", {
      source: "lemonsqueezy",
      sourceDiscountId: item.sourceDiscountId,
      message: item.reason,
    });
  const skippedCount = skipped.length + coupons.skipped.length;
  // Make partial catalog migrations detectable by automation, including previews.
  if (skippedCount) process.exitCode = 1;
  if (opts.dryRun) {
    log.info("Dry run complete. No changes were made.");
    return;
  }
  if (!products.length && !coupons.coupons.length) {
    log.info("Nothing supported to migrate.");
    return;
  }
  if (products.length && !opts.acknowledgeTaxSemantics) {
    throw new Error(
      "The Lemon Squeezy API does not expose whether prices include tax. Review the store's tax setting and destination tax behavior, then pass --acknowledge-tax-semantics. No writes made."
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
  const target = await runLemonSqueezyTargetPrompts(opts);
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
  if (coupons.coupons.length)
    log.info(
      "Coupons are created in the environment of the Pancake API key in use."
    );
  if (
    !opts.yes &&
    !(await confirm({
      message: `Create ${products.length} products and ${coupons.coupons.length} coupons in this Pancake store?`,
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
  if (results.length) {
    renderResultsTable(results);
    log.info("Lemon Squeezy → Waffo product ID mapping:");
  }
  for (const result of results) {
    console.log(
      `${result.input.sourceProductId} → ${result.pancakeProductId ?? "(not created)"} [${result.success ? "VERIFIED" : "FAILED/UNVERIFIED"}]`
    );
    audit("lemonsqueezy.product_mapping", {
      sourceProductId: result.input.sourceProductId,
      productId: result.pancakeProductId,
      verified: result.success,
      storeId: target.storeId,
    });
  }

  let failedCoupons = 0;
  if (coupons.coupons.length) {
    const creatingCoupons = spinner("Creating coupons...").start();
    const couponResults = await createPancakeCoupons({
      coupons: coupons.coupons,
      products: results,
      ...target,
      onProgress: (completed, total) => {
        creatingCoupons.text = `Creating coupons... (${completed}/${total})`;
      },
    });
    failedCoupons = couponResults.filter((r) => !r.success).length;
    if (failedCoupons)
      creatingCoupons.fail("Some coupons failed creation or verification");
    else creatingCoupons.succeed("Coupons created and verified");
    renderCouponResultsTable(couponResults);
    log.info("Lemon Squeezy discount → Waffo coupon ID mapping:");
    for (const result of couponResults) {
      console.log(
        `discount:${result.plan.sourceDiscountId} (${result.plan.code}) → ${result.couponId ?? "(not created)"} [${result.success ? "VERIFIED" : "FAILED/UNVERIFIED"}]`
      );
      audit("lemonsqueezy.coupon_mapping", {
        sourceDiscountId: result.plan.sourceDiscountId,
        couponId: result.couponId,
        verified: result.success,
        storeId: target.storeId,
      });
    }
  }
  finishMigration(failed + failedCoupons + skippedCount);
}
