import { startAudit, endAudit, audit, registerSecret, redact } from "../utils/audit.js";
import { prepareTarget, showTarget, finishMigration } from "../utils/migration.js";
import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { fetchCreemProducts } from "../creem/fetcher.js";
import { mapCreemProducts } from "../creem/mapper.js";
import { createPancakeProducts } from "../pancake/creator.js";
import { runCreemInteractivePrompts } from "../prompts/interactive.js";
import { renderPreviewTable, renderResultsTable } from "../utils/table.js";
import { log } from "../utils/logger.js";
import type { CreemCommandOptions } from "../utils/types.js";

function isFullySpecified(opts: CreemCommandOptions): boolean {
  return !!(opts.apiKey && opts.merchantId && opts.privateKey && opts.storeId);
}

export function creemCommand(): Command {
  const cmd = new Command("creem");

  cmd
    .description("Migrate products from Creem to Waffo Pancake")
    .option("--api-key <key>", "Creem API Key (creem_test_... or creem_...)")
    .option("--merchant-id <id>", "Waffo Pancake Merchant ID (MER_...)")
    .option("--private-key <path>", "Path to Pancake API private key file")
    .option("--store-id <id>", "Target Pancake Store ID (STO_...) or 'new' to create")
    .option("--store-name <name>", "Name for new store (used with --store-id new)")
    .option("--store-creation-id <id>", "Explicit new-store operation ID; reuse for retries, change only for a new creation")
    .option("--log-file <path>", "Write a new JSONL audit log to this path (must not exist)")
    .option("--dry-run", "Preview migration without creating anything")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: CreemCommandOptions) => {
      registerSecret(opts.privateKey);
      registerSecret(opts.apiKey);
      try {
        log.info(`Audit log: ${startAudit(opts.logFile)}`);
        audit("migration.started", { source: "creem", merchantId: opts.merchantId });
        await runCreemMigration(opts);
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err));
        log.error(message);
        audit("migration.failed", { error: message });
        process.exitCode = 1;
      } finally {
        endAudit();
      }
    });

  return cmd;
}

async function runCreemMigration(opts: CreemCommandOptions): Promise<void> {
  log.blank();
  console.log(chalk.bold("  Creem → Waffo Pancake Migration"));
  log.blank();

  let config: {
    apiKey: string;
    merchantId: string;
    privateKey: string;
    storeId: string;
    storeName?: string;
    storeCreationId?: string;
    dryRun: boolean;
    yes: boolean;
  };

  if (isFullySpecified(opts)) {
    config = {
      apiKey: opts.apiKey!,
      merchantId: opts.merchantId!,
      privateKey: opts.privateKey!,
      storeId: opts.storeId!,
      storeName: opts.storeName,
      storeCreationId: opts.storeCreationId,
      dryRun: opts.dryRun ?? false,
      yes: opts.yes ?? false,
    };
  } else {
    config = await runCreemInteractivePrompts(opts);
  }

  const isTestKey = config.apiKey.startsWith("creem_test_");
  const envLabel = isTestKey ? "test" : "production";

  log.info(`Environment: Creem ${envLabel} → Pancake test versions (not published)`);
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
  if (config.storeCreationId !== undefined && (config.storeId !== "new" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.storeCreationId))) {
    throw new Error("--store-creation-id requires --store-id new and 1-128 letters, numbers, underscores or hyphens");
  }
  if (config.storeId === "new" && (!config.storeName?.trim() || config.storeName.trim().length > 48)) {
    throw new Error("--store-id new requires --store-name (1-48 characters)");
  }
  log.info(`Target: ${config.storeId === "new" ? `new store: ${config.storeName}` : config.storeId}`);

  // Phase 1: Fetch
  console.log(chalk.bold("  Phase 1: Fetching data from Creem"));
  log.blank();

  const fetchSpinner = ora("Fetching products...").start();
  const creemProducts = await fetchCreemProducts(config.apiKey, isTestKey);
  fetchSpinner.succeed(`Found ${chalk.bold(creemProducts.length)} active products`);

  if (creemProducts.length === 0) {
    log.info("No active products found in Creem. Nothing to migrate.");
    return;
  }

  // Phase 2: Map & Preview
  log.blank();
  console.log(chalk.bold("  Phase 2: Migration Preview"));
  log.blank();

  const { products, warnings, skipped } = mapCreemProducts(creemProducts);

  if (products.length === 0) {
    log.warn("No products could be mapped. Check skipped items.");
    return;
  }

  console.log(
    chalk.underline(`Products (${products.length} to create, ${skipped.length} skipped):`)
  );
  log.blank();
  renderPreviewTable(products, warnings, skipped);
  log.blank();

  if (config.dryRun) {
    log.info("Dry run complete. No changes were made.");
    return;
  }

  // Phase 3: Confirm & Execute
  if (!config.yes) {
    const { confirm } = await import("@inquirer/prompts");
    const proceed = await confirm({
      message: `Create ${products.length} products in Pancake?`,
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

  config.storeId = await prepareTarget(config.merchantId, privateKeyContent, config.storeId, config.storeName, config.storeCreationId);
  showTarget(config.storeId);
  let failures = 0;

  const createSpinner = ora("Creating products...").start();
  const results = await createPancakeProducts({
    products,
    merchantId: config.merchantId,
    privateKey: privateKeyContent,
    storeId: config.storeId,
    onProgress: (completed, total) => {
      createSpinner.text = `Creating products... (${completed}/${total})`;
    },
  });
  const productFailures = results.filter(result => !result.success).length;
  failures += productFailures;
  if (productFailures) createSpinner.fail("Some products failed creation or verification");
  else createSpinner.succeed("Products created and verified");
  log.blank();
  renderResultsTable(results);

  log.blank();
  finishMigration(failures);
  log.blank();
}
