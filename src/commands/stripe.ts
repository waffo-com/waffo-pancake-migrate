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
import { Command } from "commander";
import { spinner as ora, stopSpinners } from "../utils/spinner.js";
import chalk from "chalk";
import {
  fetchStripeProducts,
  fetchStripeBranding,
  fetchStripeWebhooks,
} from "../stripe/fetcher.js";
import { mapProducts } from "../mapper/index.js";
import {
  createPancakeProducts,
  migrateWebhooks,
  migrateStoreBranding,
} from "../pancake/creator.js";
import { runInteractivePrompts } from "../prompts/interactive.js";
import { renderPreviewTable, renderResultsTable } from "../utils/table.js";
import { log } from "../utils/logger.js";
import type {
  StripeCommandOptions,
  PancakeTaxCategory,
} from "../utils/types.js";

function isFullySpecified(opts: StripeCommandOptions): boolean {
  return !!(
    opts.stripeKey &&
    opts.merchantId &&
    opts.privateKey &&
    opts.storeId &&
    opts.taxCategory
  );
}

export function stripeCommand(): Command {
  const cmd = new Command("stripe");

  cmd
    .description(
      "Migrate products, webhooks, and branding from Stripe to Waffo Pancake"
    )
    .option(
      "--stripe-key <key>",
      "Stripe Secret Key (sk_test_... or sk_live_...)"
    )
    .option("--merchant-id <id>", "Waffo Pancake Merchant ID (MER_...)")
    .option("--private-key <path>", "Path to Pancake API private key file")
    .option(
      "--store-id <id>",
      "Target Pancake Store ID (STO_...) or 'new' to create"
    )
    .option(
      "--store-name <name>",
      "Name for new store (used with --store-id new)"
    )
    .option(
      "--tax-category <category>",
      "Default tax category for all products"
    )
    .option(
      "--store-creation-id <id>",
      "Explicit new-store operation ID; reuse for retries, change only for a new creation"
    )
    .option(
      "--log-file <path>",
      "Write a new JSONL audit log to this path (must not exist)"
    )
    .option("--dry-run", "Preview migration without creating anything")
    .option("--yes", "Skip confirmation prompt")
    .option("--skip-products", "Skip product migration")
    .option("--skip-webhooks", "Skip webhook migration")
    .option("--skip-branding", "Skip store branding migration")
    .action(async (opts: StripeCommandOptions) => {
      registerSecret(opts.privateKey);
      registerSecret(opts.stripeKey);
      try {
        log.info(`Audit log: ${startAudit(opts.logFile)}`);
        audit("migration.started", {
          source: "stripe",
          merchantId: opts.merchantId,
        });
        await runStripeMigration(opts);
      } catch (err) {
        stopSpinners();
        const message = redact(
          err instanceof Error ? err.message : String(err)
        );
        log.error(message);
        audit("migration.failed", { error: message });
        process.exitCode = 1;
      } finally {
        stopSpinners();
        endAudit();
      }
    });

  return cmd;
}

async function runStripeMigration(opts: StripeCommandOptions): Promise<void> {
  log.blank();
  console.log(chalk.bold("  Stripe → Waffo Pancake Migration"));
  log.blank();

  let failures = 0;

  // Resolve config
  let config: {
    stripeKey: string;
    merchantId: string;
    privateKey: string;
    storeId: string;
    storeName?: string;
    storeCreationId?: string;
    taxCategory: PancakeTaxCategory;
    dryRun: boolean;
    yes: boolean;
  };

  if (isFullySpecified(opts)) {
    config = {
      stripeKey: opts.stripeKey!,
      merchantId: opts.merchantId!,
      privateKey: opts.privateKey!,
      storeId: opts.storeId!,
      storeName: opts.storeName,
      storeCreationId: opts.storeCreationId,
      taxCategory: opts.taxCategory!,
      dryRun: opts.dryRun ?? false,
      yes: opts.yes ?? false,
    };
  } else {
    config = await runInteractivePrompts(opts);
  }

  const isTestKey = config.stripeKey.startsWith("sk_test_");
  const envLabel = isTestKey ? "test" : "production";

  if (!isTestKey) {
    log.warn(
      "You are using a Stripe live key. Data will be read from your production Stripe account."
    );
    log.blank();
  }

  log.info(
    `Environment: Stripe ${envLabel} → Pancake test versions (not published)`
  );
  log.blank();

  // Read private key file if needed
  let privateKeyContent = config.privateKey;
  const looksLikeFilePath =
    privateKeyContent.length < 256 &&
    !privateKeyContent.includes("-----") &&
    !privateKeyContent.includes("=");
  if (looksLikeFilePath) {
    const fs = await import("fs/promises");
    privateKeyContent = await fs.readFile(privateKeyContent, "utf-8");
  }

  registerSecret(privateKeyContent);
  if (
    config.storeCreationId !== undefined &&
    (config.storeId !== "new" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(config.storeCreationId))
  ) {
    throw new Error(
      "--store-creation-id requires --store-id new and 1-128 letters, numbers, underscores or hyphens"
    );
  }
  if (
    config.storeId === "new" &&
    (!config.storeName?.trim() || config.storeName.trim().length > 48)
  ) {
    throw new Error("--store-id new requires --store-name (1-48 characters)");
  }
  log.info(
    `Target: ${config.storeId === "new" ? `new store: ${config.storeName}` : config.storeId}`
  );

  // ═══════════════════════════════════════════
  // Phase 1: Fetch all data from Stripe
  // ═══════════════════════════════════════════
  console.log(chalk.bold("  Phase 1: Fetching data from Stripe"));
  log.blank();

  // Fetch products
  let stripeProducts: Awaited<ReturnType<typeof fetchStripeProducts>> = [];
  if (!opts.skipProducts) {
    const productSpinner = ora("Fetching products & prices...").start();
    stripeProducts = await fetchStripeProducts(config.stripeKey);
    productSpinner.succeed(
      `Found ${chalk.bold(stripeProducts.length)} products with prices`
    );
  }

  // Fetch branding
  let branding: Awaited<ReturnType<typeof fetchStripeBranding>> | null = null;
  if (!opts.skipBranding) {
    const brandingSpinner = ora("Fetching account branding...").start();
    try {
      branding = await fetchStripeBranding(config.stripeKey);
      const fields = [
        branding.businessName && "name",
        branding.supportEmail && "email",
        branding.websiteUrl && "website",
      ].filter(Boolean);
      brandingSpinner.succeed(
        fields.length > 0
          ? `Found branding: ${fields.join(", ")}`
          : "No branding info found"
      );
    } catch (error) {
      failures++;
      log.warn(
        error instanceof Error
          ? error.message
          : "Source read failed; see audit log"
      );
      brandingSpinner.warn(
        "Could not fetch branding (may require Connect account)"
      );
    }
  }

  // Fetch webhooks
  let stripeWebhooks: Awaited<ReturnType<typeof fetchStripeWebhooks>> = [];
  if (!opts.skipWebhooks) {
    const whSpinner = ora("Fetching webhook endpoints...").start();
    try {
      stripeWebhooks = await fetchStripeWebhooks(config.stripeKey);
      whSpinner.succeed(
        `Found ${chalk.bold(stripeWebhooks.length)} webhook endpoints`
      );
    } catch (error) {
      failures++;
      log.warn(
        error instanceof Error
          ? error.message
          : "Source read failed; see audit log"
      );
      whSpinner.warn("Could not fetch webhooks");
    }
  }

  // ═══════════════════════════════════════════
  // Phase 2: Preview
  // ═══════════════════════════════════════════
  log.blank();
  console.log(chalk.bold("  Phase 2: Migration Preview"));
  log.blank();

  // Products preview
  let mappedProducts: ReturnType<typeof mapProducts> | null = null;
  if (!opts.skipProducts && stripeProducts.length > 0) {
    mappedProducts = mapProducts(stripeProducts, config.taxCategory);
    console.log(
      chalk.underline(
        `Products (${mappedProducts.products.length} to create, ${mappedProducts.skipped.length} skipped):`
      )
    );
    log.blank();
    renderPreviewTable(
      mappedProducts.products,
      mappedProducts.warnings,
      mappedProducts.skipped
    );
    log.blank();
  } else if (!opts.skipProducts) {
    log.dim("  No products to migrate.");
    log.blank();
  }

  // Branding preview
  if (branding && (branding.supportEmail || branding.websiteUrl)) {
    console.log(chalk.underline("Store branding:"));
    if (branding.supportEmail)
      log.info(`  Support email: ${branding.supportEmail}`);
    if (branding.websiteUrl) log.info(`  Website: ${branding.websiteUrl}`);
    if (branding.businessName)
      log.info(
        `  Business name: ${branding.businessName} (info only, not written)`
      );
    log.blank();
  }

  // Webhooks preview
  if (stripeWebhooks.length > 0) {
    console.log(
      chalk.underline(`Webhooks (${stripeWebhooks.length} endpoints):`)
    );
    for (const wh of stripeWebhooks) {
      log.info(`  ${wh.url}`);
      log.dim(
        `    Events: ${wh.enabledEvents.length} subscribed, status: ${wh.status}`
      );
    }
    log.blank();
  }

  // Nothing to do?
  const hasProducts = mappedProducts && mappedProducts.products.length > 0;
  const hasBranding =
    branding && (branding.supportEmail || branding.websiteUrl);
  const hasWebhooks = stripeWebhooks.length > 0;

  if (!hasProducts && !hasBranding && !hasWebhooks) {
    if (failures) finishMigration(failures);
    else log.info("Nothing to migrate.");
    return;
  }

  if (config.dryRun) {
    log.info("Dry run complete. No changes were made.");
    if (failures) finishMigration(failures);
    return;
  }

  // ═══════════════════════════════════════════
  // Phase 3: Confirm & Execute
  // ═══════════════════════════════════════════
  if (!config.yes) {
    const { confirm } = await import("@inquirer/prompts");
    const items = [
      hasProducts && `${mappedProducts!.products.length} products`,
      hasBranding && "store branding",
      hasWebhooks && `${stripeWebhooks.length} webhook endpoints`,
    ].filter(Boolean);

    const proceed = await confirm({
      message: `Migrate ${items.join(", ")} to Pancake?`,
      default: true,
    });
    if (!proceed) {
      log.info("Migration cancelled.");
      return;
    }
  }

  log.blank();
  console.log(chalk.bold("  Phase 3: Executing Migration"));
  log.blank();

  config.storeId = await prepareTarget(
    config.merchantId,
    privateKeyContent,
    config.storeId,
    config.storeName,
    config.storeCreationId
  );
  showTarget(config.storeId);
  // 3a: Products
  if (hasProducts) {
    const createSpinner = ora("Creating products...").start();
    const results = await createPancakeProducts({
      products: mappedProducts!.products,
      merchantId: config.merchantId,
      privateKey: privateKeyContent,
      storeId: config.storeId,
      onProgress: (completed, total) => {
        createSpinner.text = `Creating products... (${completed}/${total})`;
      },
    });
    const productFailures = results.filter((result) => !result.success).length;
    failures += productFailures;
    if (productFailures)
      createSpinner.fail("Some products failed creation or verification");
    else createSpinner.succeed("Products created and verified");
    log.blank();
    renderResultsTable(results);
    log.blank();
  }

  // 3b: Branding
  if (hasBranding) {
    const brandSpinner = ora("Updating store branding...").start();
    const result = await migrateStoreBranding({
      merchantId: config.merchantId,
      privateKey: privateKeyContent,
      storeId: config.storeId,
      supportEmail: branding!.supportEmail,
      website: branding!.websiteUrl,
    });
    if (result.success) {
      const updated = Object.entries(result.fields)
        .filter(([, v]) => v)
        .map(([k]) => k);
      brandSpinner.succeed(`Store branding updated: ${updated.join(", ")}`);
    } else {
      failures++;
      brandSpinner.fail(`Branding update failed: ${result.error}`);
    }
  }

  // 3c: Webhooks
  if (hasWebhooks) {
    for (const wh of stripeWebhooks) {
      const whSpinner = ora(`Migrating webhook: ${wh.url}...`).start();
      const result = await migrateWebhooks({
        merchantId: config.merchantId,
        privateKey: privateKeyContent,
        storeId: config.storeId,
        stripeWebhookUrl: wh.url,
        stripeEvents: wh.enabledEvents,
        isTestKey,
      });
      if (result.success) {
        whSpinner.succeed(
          `Webhook set: ${result.events.length} events mapped` +
            (result.unmappedEvents.length > 0
              ? chalk.yellow(
                  ` (${result.unmappedEvents.length} Stripe-only events skipped)`
                )
              : "")
        );
      } else {
        failures++;
        whSpinner.fail(`Webhook failed: ${result.error}`);
      }
    }
  }

  log.blank();
  finishMigration(failures);
  log.blank();
}
