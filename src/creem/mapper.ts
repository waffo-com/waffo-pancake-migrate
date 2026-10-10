import type { CreemProduct } from "./fetcher.js";
import {
  centsToDisplay,
  type PancakeProductInput,
  type PancakeBillingPeriod,
  type PancakeTaxCategory,
  type MappingResult,
  type MappingWarning,
  type SkippedItem,
} from "../utils/types.js";

// Creem billing period → Pancake billing period
const BILLING_PERIOD_MAP: Record<string, PancakeBillingPeriod | null> = {
  "every-month": "monthly",
  "every-three-months": "quarterly",
  "every-six-months": null, // unsupported
  "every-year": "yearly",
  once: null, // onetime, not a subscription period
};

// Creem tax category → Pancake tax category
const TAX_CATEGORY_MAP: Record<string, PancakeTaxCategory> = {
  saas: "saas",
  "digital-goods-service": "digital_goods",
  ebooks: "ebook",
};

export function mapCreemProducts(products: CreemProduct[]): MappingResult {
  const mapped: PancakeProductInput[] = [];
  const warnings: MappingWarning[] = [];
  const skipped: SkippedItem[] = [];

  for (const p of products) {
    const currency = p.currency.toUpperCase();
    const taxCategory = TAX_CATEGORY_MAP[p.taxCategory] ?? "digital_goods";
    const displayAmount = centsToDisplay(p.price, currency);

    if (p.billingType === "onetime" || p.billingPeriod === "once") {
      // One-time product
      mapped.push({
        type: "onetime",
        name: p.name,
        description: p.description || null,
        prices: {
          [currency]: { amount: displayAmount, taxCategory },
        },
        media: p.imageUrl ? [{ type: "image", url: p.imageUrl }] : [],
        metadata: {
          _creemProductId: p.id,
        },
        sourceProductId: p.id,
        sourcePriceIds: [p.id],
      });
    } else {
      // Subscription
      const billingPeriod = BILLING_PERIOD_MAP[p.billingPeriod];

      if (!billingPeriod) {
        if (p.billingPeriod === "every-six-months") {
          skipped.push({
            sourceProductId: p.id,
            sourceProductName: p.name,
            reason: "Unsupported billing period: every 6 months",
          });
          warnings.push({
            sourceProductId: p.id,
            sourceProductName: p.name,
            message: "Skipped: every-six-months not supported by Pancake",
            severity: "warn",
          });
        }
        continue;
      }

      mapped.push({
        type: "subscription",
        name: p.name,
        description: p.description || null,
        billingPeriod,
        prices: {
          [currency]: { amount: displayAmount, taxCategory },
        },
        media: p.imageUrl ? [{ type: "image", url: p.imageUrl }] : [],
        metadata: {
          _creemProductId: p.id,
        },
        sourceProductId: p.id,
        sourcePriceIds: [p.id],
      });
    }
  }

  return { products: mapped, warnings, skipped };
}
