import type Stripe from "stripe";
import { mapInterval } from "./interval-mapper.js";
import {
  centsToDisplay,
  type PancakePriceInfo,
  type PancakeTaxCategory,
  type PancakeBillingPeriod,
  type MappingWarning,
} from "../utils/types.js";

export interface PriceGroup {
  type: "onetime" | "subscription";
  billingPeriod?: PancakeBillingPeriod;
  groupLabel: string;
  prices: Record<string, PancakePriceInfo>;
  stripePriceIds: string[];
}

export interface GroupingResult {
  groups: PriceGroup[];
  warnings: MappingWarning[];
}

function groupKey(price: Stripe.Price): string {
  if (price.type === "one_time") return "one_time";
  const interval = price.recurring?.interval ?? "unknown";
  const count = price.recurring?.interval_count ?? 1;
  return `recurring:${interval}:${count}`;
}

function groupLabel(price: Stripe.Price): string {
  if (price.type === "one_time") return "One-Time";
  const interval = price.recurring?.interval;
  const count = price.recurring?.interval_count ?? 1;
  if (interval === "week" && count === 1) return "Weekly";
  if (interval === "month" && count === 1) return "Monthly";
  if (interval === "month" && count === 3) return "Quarterly";
  if (interval === "year" && count === 1) return "Yearly";
  return `${interval}/${count}`;
}

export function groupPricesByCurrency(
  prices: Stripe.Price[],
  defaultTaxCategory: PancakeTaxCategory,
  stripeProductId: string,
  stripeProductName: string
): GroupingResult {
  const warnings: MappingWarning[] = [];
  const groupMap = new Map<
    string,
    { prices: Stripe.Price[]; label: string }
  >();

  for (const price of prices) {
    // Skip tiered pricing
    if (price.billing_scheme === "tiered") {
      warnings.push({
        stripeProductId,
        stripeProductName,
        message: `Skipped tiered price ${price.id}`,
        severity: "warn",
      });
      continue;
    }

    // Skip null amounts
    if (price.unit_amount == null) {
      warnings.push({
        stripeProductId,
        stripeProductName,
        message: `Skipped price ${price.id} (no unit_amount)`,
        severity: "warn",
      });
      continue;
    }

    // Check interval support for recurring
    if (price.type === "recurring" && price.recurring) {
      const mapping = mapInterval(
        price.recurring.interval,
        price.recurring.interval_count ?? 1
      );
      if (!mapping.supported) {
        warnings.push({
          stripeProductId,
          stripeProductName,
          message: mapping.reason,
          severity: "warn",
        });
        continue;
      }
    }

    const key = groupKey(price);
    const existing = groupMap.get(key);
    if (existing) {
      existing.prices.push(price);
    } else {
      groupMap.set(key, { prices: [price], label: groupLabel(price) });
    }
  }

  // Convert groups
  const groups: PriceGroup[] = [];

  for (const [key, { prices: groupPrices, label }] of groupMap) {
    const pancakePrices: Record<string, PancakePriceInfo> = {};
    const stripePriceIds: string[] = [];

    for (const price of groupPrices) {
      const currency = price.currency.toUpperCase();

      if (pancakePrices[currency]) {
        warnings.push({
          stripeProductId,
          stripeProductName,
          message: `Duplicate ${currency} price in ${label} group, using first`,
          severity: "warn",
        });
        continue;
      }

      pancakePrices[currency] = {
        amount: centsToDisplay(price.unit_amount!, currency),
        taxCategory: defaultTaxCategory,
      };
      stripePriceIds.push(price.id);
    }

    if (key === "one_time") {
      groups.push({
        type: "onetime",
        groupLabel: label,
        prices: pancakePrices,
        stripePriceIds,
      });
    } else {
      const firstPrice = groupPrices[0];
      const mapping = mapInterval(
        firstPrice.recurring!.interval,
        firstPrice.recurring!.interval_count ?? 1
      );
      if (mapping.supported) {
        groups.push({
          type: "subscription",
          billingPeriod: mapping.billingPeriod,
          groupLabel: label,
          prices: pancakePrices,
          stripePriceIds,
        });
      }
    }
  }

  return { groups, warnings };
}
