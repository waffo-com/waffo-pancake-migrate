import { groupPricesByCurrency } from "./currency-grouper.js";
import { mapMedia } from "./media-mapper.js";
import type {
  StripeProductWithPrices,
  PancakeTaxCategory,
  PancakeProductInput,
  MappingResult,
  MappingWarning,
  SkippedItem,
} from "../utils/types.js";

export function mapProducts(
  stripeProducts: StripeProductWithPrices[],
  defaultTaxCategory: PancakeTaxCategory
): MappingResult {
  const products: PancakeProductInput[] = [];
  const allWarnings: MappingWarning[] = [];
  const skipped: SkippedItem[] = [];

  for (const { product, prices } of stripeProducts) {
    // Group prices by (type, interval)
    const { groups, warnings } = groupPricesByCurrency(
      prices,
      defaultTaxCategory,
      product.id,
      product.name
    );
    allWarnings.push(...warnings);

    // Skip if no valid groups
    if (groups.length === 0) {
      skipped.push({
        stripeId: product.id,
        stripeName: product.name,
        reason: "No supported prices after filtering",
      });
      continue;
    }

    const media = mapMedia(product.images ?? []);
    const needsSuffix = groups.length > 1;

    for (const group of groups) {
      const name = needsSuffix
        ? `${product.name} (${group.groupLabel})`
        : product.name;

      products.push({
        type: group.type,
        name,
        description: product.description ?? null,
        prices: group.prices,
        billingPeriod: group.billingPeriod,
        media,
        metadata: {
          ...((product.metadata as Record<string, unknown>) ?? {}),
          _stripeProductId: product.id,
          _stripePriceIds: group.stripePriceIds.join(","),
        },
        stripeProductId: product.id,
        stripePriceIds: group.stripePriceIds,
      });
    }
  }

  return { products, warnings: allWarnings, skipped };
}
