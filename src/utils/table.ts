import Table from "cli-table3";
import chalk from "chalk";
import type {
  PancakeProductInput,
  MappingWarning,
  SkippedItem,
  MigrationResult,
  CouponMappingResult,
  CouponMigrationResult,
  CouponPlan,
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
    const existing = warningsByProduct.get(w.sourceProductId) ?? [];
    existing.push(w.message);
    warningsByProduct.set(w.sourceProductId, existing);
  }

  for (const p of products) {
    const priceStrs = Object.entries(p.prices)
      .map(([cur, info]) => `${cur} ${info.amount}`)
      .join(", ");

    const type =
      p.type === "subscription"
        ? `subscription (${p.billingPeriod})`
        : "one-time";

    const notes = warningsByProduct.get(p.sourceProductId)?.join("; ") ?? "";

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
      skipTable.push([s.sourceProductName, s.reason]);
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
      r.success
        ? chalk.green("VERIFIED")
        : chalk.red(r.pancakeProductId ? "UNVERIFIED" : "FAIL"),
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

function describeCoupon(plan: CouponPlan): string {
  const value =
    plan.discount.type === "percentage"
      ? `${plan.discount.percentOff}% off`
      : Object.entries(plan.discount.amountOff)
          .map(([currency, amount]) => `${currency} ${amount} off`)
          .join(", ");
  const duration =
    plan.duration === "repeating"
      ? `${plan.durationInPeriods} periods`
      : plan.duration;
  return `${value}, ${duration}`;
}

export function renderCouponPreviewTable(mapping: CouponMappingResult): void {
  const { coupons, warnings, skipped } = mapping;
  if (coupons.length) {
    const table = new Table({
      head: [
        chalk.bold("Code"),
        chalk.bold("Discount"),
        chalk.bold("Limits"),
        chalk.bold("Notes"),
      ],
      colWidths: [20, 26, 26, 30],
      wordWrap: true,
    });
    for (const plan of coupons) {
      const limits = [
        plan.sourceProductIds.length
          ? `${plan.sourceProductIds.length} product(s)`
          : "whole store",
        plan.maxRedemptions !== null ? `max ${plan.maxRedemptions}` : null,
        plan.redeemBy ? `until ${plan.redeemBy}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      const notes = warnings
        .filter((w) => w.sourceDiscountId === plan.sourceDiscountId)
        .map((w) => w.message)
        .join("; ");
      table.push([
        plan.code,
        describeCoupon(plan),
        limits,
        notes ? chalk.yellow(notes) : chalk.dim("—"),
      ]);
    }
    console.log(table.toString());
  }
  if (skipped.length) {
    console.log();
    console.log(chalk.yellow.bold(`Skipped discounts (${skipped.length}):`));
    const skipTable = new Table({
      head: [chalk.bold("Code"), chalk.bold("Reason")],
      colWidths: [30, 50],
      wordWrap: true,
    });
    for (const s of skipped) skipTable.push([s.code, s.reason]);
    console.log(skipTable.toString());
  }
}

export function renderCouponResultsTable(
  results: CouponMigrationResult[]
): void {
  const table = new Table({
    head: [
      chalk.bold("Code"),
      chalk.bold("Status"),
      chalk.bold("Pancake ID"),
      chalk.bold("Error"),
    ],
    colWidths: [20, 14, 30, 40],
    wordWrap: true,
  });
  for (const r of results)
    table.push([
      r.plan.code,
      r.success
        ? chalk.green("VERIFIED")
        : chalk.red(r.couponId ? "UNVERIFIED" : "FAIL"),
      r.couponId ?? chalk.dim("—"),
      r.error ?? chalk.dim("—"),
    ]);
  console.log(table.toString());
}
