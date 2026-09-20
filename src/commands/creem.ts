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
    .option("--dry-run", "Preview migration without creating anything")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: CreemCommandOptions) => {
      try {
        await runCreemMigration(opts);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
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
    dryRun: boolean;
    yes: boolean;
  };

  if (isFullySpecified(opts)) {
    config = {
      apiKey: opts.apiKey!,
      merchantId: opts.merchantId!,
      privateKey: opts.privateKey!,
      storeId: opts.storeId!,
      dryRun: opts.dryRun ?? false,
      yes: opts.yes ?? false,
    };
  } else {
    config = await runCreemInteractivePrompts(opts);
  }

  const isTestKey = config.apiKey.startsWith("creem_test_");
  const envLabel = isTestKey ? "test" : "production";

  log.info(`Environment: Creem ${envLabel} → Pancake`);
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
  createSpinner.succeed("Products created");
  log.blank();
  renderResultsTable(results);

  log.blank();
  log.success("Migration complete!");
  log.blank();
}
