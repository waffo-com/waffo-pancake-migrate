import Table from "cli-table3";
import chalk from "chalk";
import type {
  PancakeProductInput,
  MappingWarning,
  SkippedItem,
  MigrationResult,
} from "./types.js";

export function renderPreviewTable(
  products: PancakeProductInput[],
  warnings: MappingWarning[],
  skipped: SkippedItem[]
): void {
  const table = new Table({
    head: [
      chalk.bold("Product"),
      chalk.bold("Type"),
      chalk.bold("Prices"),
      chalk.bold("Notes"),
    ],
    colWidths: [30, 14, 28, 30],
    wordWrap: true,
  });

  const warningsByProduct = new Map<string, string[]>();
  for (const w of warnings) {
    const existing = warningsByProduct.get(w.stripeProductId) ?? [];
    existing.push(w.message);
    warningsByProduct.set(w.stripeProductId, existing);
  }

  for (const p of products) {
    const priceStrs = Object.entries(p.prices)
      .map(([cur, info]) => `${cur} ${info.amount}`)
      .join(", ");

    const type =
      p.type === "subscription"
        ? `subscription (${p.billingPeriod})`
        : "one-time";

    const notes = warningsByProduct.get(p.stripeProductId)?.join("; ") ?? "";

    table.push([
      p.name,
      type,
      priceStrs,
      notes ? chalk.yellow(notes) : chalk.dim("—"),
    ]);
  }

  console.log(table.toString());

  if (skipped.length > 0) {
    console.log();
    console.log(chalk.yellow.bold(`Skipped (${skipped.length}):`));
    const skipTable = new Table({
      head: [chalk.bold("Product"), chalk.bold("Reason")],
      colWidths: [30, 50],
      wordWrap: true,
    });
    for (const s of skipped) {
      skipTable.push([s.stripeName, s.reason]);
    }
    console.log(skipTable.toString());
  }
}

export function renderResultsTable(results: MigrationResult[]): void {
  const table = new Table({
    head: [
      chalk.bold("Product"),
      chalk.bold("Status"),
      chalk.bold("Pancake ID"),
      chalk.bold("Version"),
      chalk.bold("Error"),
    ],
    colWidths: [25, 14, 30, 14, 30],
    wordWrap: true,
  });

  for (const r of results) {
    table.push([
      r.input.name,
      r.success ? chalk.green("VERIFIED") : chalk.red(r.pancakeProductId ? "UNVERIFIED" : "FAIL"),
      r.pancakeProductId ?? chalk.dim("—"),
      r.success ? (r.hasProdVersion ? "Test + prod" : "Test only") : "Unknown",
      r.error ?? chalk.dim("—"),
    ]);
  }

  console.log(table.toString());

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  console.log();
  console.log(
    `${chalk.green.bold(succeeded)} verified, ${failed > 0 ? chalk.red.bold(failed) : chalk.dim(0)} failed`
  );
}
