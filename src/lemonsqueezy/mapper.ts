import { minorUnitsToDisplay } from "../dodo/currency.js";
import type {
  LemonSqueezyCatalog,
  LemonSqueezyDiscount,
  LemonSqueezyProduct,
  LemonSqueezyVariant,
} from "./fetcher.js";
import type {
  CouponPlan,
  CouponMappingResult,
  MappingResult,
  PancakeBillingPeriod,
  PancakeProductInput,
  PancakeTaxCategory,
} from "../utils/types.js";

const TAX_CATEGORIES: Record<string, PancakeTaxCategory | undefined> = {
  eservice: "digital_goods",
  ebook: "ebook",
  saas: "saas",
};
const PERIODS: Record<string, PancakeBillingPeriod | undefined> = {
  "week:1": "weekly",
  "month:1": "monthly",
  "month:3": "quarterly",
  "month:12": "yearly",
  "year:1": "yearly",
};
/** Pancake coupon and promotion code format. */
const CODE_PATTERN = /^[A-Za-z0-9-]{3,32}$/;
const COUPON_NAME_LIMIT = 64;

export const variantSourceId = (variantId: string) => `variant:${variantId}`;
const productSourceId = (productId: string) => `product:${productId}`;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** Lemon Squeezy descriptions are HTML; Pancake shows descriptions as plain text. */
export function htmlToText(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?\w+);/g, (match, name: string) => {
      if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
      const code = /^#(\d+)$/.exec(name)?.[1];
      return code ? String.fromCodePoint(Number(code)) : match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/** Variants a buyer can actually purchase: published ones, else the hidden default variant. */
/**
 * Pending variants of products that also have published variants. Lemon Squeezy keeps the
 * original default variant hidden once variants are added, and selecting a whole product for a
 * discount links it too. Buyers can never purchase it, so a restriction may ignore it.
 */
function hiddenDefaultVariantIds(catalog: LemonSqueezyCatalog): Set<string> {
  const hidden = new Set<string>();
  for (const product of catalog.products)
    if (product.variants.some((v) => v.status === "published"))
      for (const variant of product.variants)
        if (variant.status === "pending") hidden.add(variant.id);
  return hidden;
}

function sellableVariants(product: LemonSqueezyProduct) {
  const published = product.variants.filter((v) => v.status === "published");
  if (published.length) return { variants: published, isDefault: false };
  if (product.variants.length === 1 && product.variants[0].status === "pending")
    return { variants: product.variants, isDefault: true };
  return { variants: [], isDefault: false };
}

function mapVariant(
  product: LemonSqueezyProduct,
  variant: LemonSqueezyVariant,
  isDefault: boolean,
  catalog: LemonSqueezyCatalog,
  warn: (message: string) => void
): PancakeProductInput {
  const price = variant.price;
  if (!price) throw new Error("Variant has no price");
  if (price.category === "lead_magnet")
    throw new Error("Unsupported free lead magnet");
  if (price.category === "pwyw")
    throw new Error("Unsupported pay-what-you-want pricing");
  if (price.category !== "one_time" && price.category !== "subscription")
    throw new Error(`Unsupported price category: ${price.category}`);
  if (price.scheme !== "standard")
    throw new Error(`Unsupported pricing scheme: ${price.scheme}`);
  if (price.usage_aggregation)
    throw new Error("Unsupported usage-based billing");
  if (price.setup_fee_enabled)
    throw new Error("Unsupported subscription setup fee");
  if (
    price.trial_interval_unit &&
    (price.trial_interval_quantity ?? 0) > 0 &&
    variant.has_free_trial !== false
  )
    throw new Error(
      `Unsupported free trial (${price.trial_interval_quantity} ${price.trial_interval_unit})`
    );
  const taxCategory =
    price.tax_code && Object.hasOwn(TAX_CATEGORIES, price.tax_code)
      ? TAX_CATEGORIES[price.tax_code]
      : undefined;
  if (!taxCategory)
    throw new Error(`Unsupported tax category: ${price.tax_code ?? "none"}`);
  const amount = minorUnitsToDisplay(price.unit_price, catalog.store.currency);
  if (Number(amount) === 0) throw new Error("Unsupported free price");

  let billingPeriod: PancakeBillingPeriod | undefined;
  if (price.category === "subscription") {
    billingPeriod =
      PERIODS[
        `${price.renewal_interval_unit}:${price.renewal_interval_quantity}`
      ];
    if (!billingPeriod)
      throw new Error(
        `Unsupported billing interval: ${price.renewal_interval_quantity} ${price.renewal_interval_unit}`
      );
  }
  if (variant.has_license_keys)
    warn(
      "License keys are not migrated; issue keys for new sales through a separate integration."
    );
  const image = product.large_thumb_url || product.thumb_url;
  return {
    type: billingPeriod ? "subscription" : "onetime",
    name: isDefault ? product.name : `${product.name} - ${variant.name}`,
    description:
      (!isDefault && htmlToText(variant.description)) ||
      htmlToText(product.description),
    billingPeriod,
    prices: { [catalog.store.currency]: { amount, taxCategory } },
    media: image ? [{ type: "image", url: image }] : [],
    metadata: {
      _lemonSqueezyStoreId: catalog.store.id,
      _lemonSqueezyProductId: product.id,
      _lemonSqueezyVariantId: variant.id,
      _lemonSqueezyPriceId: price.id,
      _lemonSqueezyTaxCode: price.tax_code,
    },
    sourceProductId: variantSourceId(variant.id),
    sourcePriceIds: [price.id],
  };
}

export function mapLemonSqueezyProducts(
  catalog: LemonSqueezyCatalog
): MappingResult {
  const result: MappingResult = { products: [], warnings: [], skipped: [] };
  for (const product of catalog.products) {
    const skip = (id: string, name: string, reason: string) =>
      result.skipped.push({
        sourceProductId: id,
        sourceProductName: name,
        reason,
      });
    if (product.status !== "published") {
      skip(productSourceId(product.id), product.name, "Draft product");
      continue;
    }
    const { variants, isDefault } = sellableVariants(product);
    if (!variants.length) {
      skip(productSourceId(product.id), product.name, "No published variants");
      continue;
    }
    for (const variant of product.variants)
      if (variant.status === "draft")
        skip(
          variantSourceId(variant.id),
          `${product.name} - ${variant.name}`,
          "Draft variant"
        );
    for (const variant of variants) {
      const sourceProductId = variantSourceId(variant.id);
      const name = isDefault
        ? product.name
        : `${product.name} - ${variant.name}`;
      try {
        result.products.push(
          mapVariant(product, variant, isDefault, catalog, (message) =>
            result.warnings.push({
              sourceProductId,
              sourceProductName: name,
              message,
              severity: "warn",
            })
          )
        );
      } catch (error) {
        skip(
          sourceProductId,
          name,
          error instanceof Error ? error.message : "Unsupported configuration"
        );
      }
    }
  }
  return result;
}

function mapDiscount(
  discount: LemonSqueezyDiscount,
  catalog: LemonSqueezyCatalog,
  products: PancakeProductInput[],
  now: number,
  warn: (message: string) => void
): CouponPlan {
  if (discount.status !== "published") throw new Error("Draft discount");
  if (discount.expires_at && !(Date.parse(discount.expires_at) > now))
    throw new Error("Expired discount");
  if (discount.starts_at && Date.parse(discount.starts_at) > now)
    throw new Error("Starts in the future; Pancake coupons have no start date");
  const code = discount.code.trim();
  if (!CODE_PATTERN.test(code))
    throw new Error("Code must be 3-32 letters, digits or hyphens in Pancake");

  let couponDiscount: CouponPlan["discount"];
  if (discount.amount_type === "percent") {
    if (
      !Number.isInteger(discount.amount) ||
      discount.amount < 1 ||
      discount.amount > 100
    )
      throw new Error(`Invalid percentage: ${discount.amount}`);
    couponDiscount = { type: "percentage", percentOff: discount.amount };
  } else if (discount.amount_type === "fixed") {
    const display = minorUnitsToDisplay(
      discount.amount,
      catalog.store.currency
    );
    if (Number(display) === 0) throw new Error("Invalid fixed amount: 0");
    couponDiscount = {
      type: "fixed_amount",
      amountOff: { [catalog.store.currency]: display },
    };
  } else throw new Error(`Unsupported amount type: ${discount.amount_type}`);

  let maxRedemptions: number | null = null;
  if (discount.is_limited_redemptions) {
    if (
      !Number.isInteger(discount.max_redemptions) ||
      (discount.max_redemptions ?? 0) < 1
    )
      throw new Error("Invalid redemption limit");
    maxRedemptions = discount.max_redemptions;
    warn(
      `Redemption limit restarts at ${maxRedemptions}; past Lemon Squeezy redemptions are not counted.`
    );
  }

  const byVariant = new Map(
    products.map((p) => [p.sourceProductId, p] as const)
  );
  let applicable = products;
  const sourceProductIds: string[] = [];
  if (discount.is_limited_to_products) {
    const hidden = hiddenDefaultVariantIds(catalog);
    const variantIds = discount.variantIds.filter((id) => !hidden.has(id));
    if (!variantIds.length)
      throw new Error("Limited to products, but no variants are linked");
    const missing = variantIds.filter(
      (id) => !byVariant.has(variantSourceId(id))
    );
    if (missing.length)
      throw new Error(
        `Applies to variant(s) that are not migrated: ${missing.join(", ")}`
      );
    sourceProductIds.push(...variantIds.map(variantSourceId));
    applicable = sourceProductIds.map((id) => byVariant.get(id)!);
  }

  let duration: CouponPlan["duration"];
  let durationInPeriods: number | null = null;
  if (discount.duration === "once" || discount.duration === "forever")
    duration = discount.duration;
  else if (discount.duration === "repeating") {
    const months = discount.duration_in_months;
    if (!Number.isInteger(months) || (months ?? 0) < 1)
      throw new Error("Invalid repeating duration");
    // Lemon Squeezy counts months; Pancake counts billing periods.
    if (
      applicable.some(
        (p) => p.type === "subscription" && p.billingPeriod !== "monthly"
      )
    )
      throw new Error(
        `Repeating for ${months} month(s) applies to non-monthly subscriptions; Pancake counts billing periods, not months`
      );
    duration = "repeating";
    durationInPeriods = months;
  } else throw new Error(`Unsupported duration: ${discount.duration}`);

  return {
    sourceDiscountId: discount.id,
    name: (discount.name.trim() || code).slice(0, COUPON_NAME_LIMIT),
    code,
    discount: couponDiscount,
    duration,
    durationInPeriods,
    maxRedemptions,
    // Lemon Squeezy uses microsecond timestamps; send a standard ISO 8601 instant.
    redeemBy: discount.expires_at
      ? new Date(discount.expires_at).toISOString()
      : null,
    sourceProductIds,
  };
}

export function mapLemonSqueezyDiscounts(
  catalog: LemonSqueezyCatalog,
  products: PancakeProductInput[],
  now = Date.now()
): CouponMappingResult {
  const result: CouponMappingResult = {
    coupons: [],
    warnings: [],
    skipped: [],
  };
  const codes = new Set<string>();
  for (const discount of catalog.discounts) {
    try {
      const plan = mapDiscount(discount, catalog, products, now, (message) =>
        result.warnings.push({
          sourceDiscountId: discount.id,
          name: discount.name,
          message,
        })
      );
      const normalized = plan.code.toUpperCase();
      if (codes.has(normalized)) throw new Error("Duplicate code");
      codes.add(normalized);
      result.coupons.push(plan);
    } catch (error) {
      result.skipped.push({
        sourceDiscountId: discount.id,
        name: discount.name,
        code: discount.code,
        reason:
          error instanceof Error ? error.message : "Unsupported configuration",
      });
    }
  }
  // Warnings only describe coupons that will actually be created.
  const kept = new Set(result.coupons.map((c) => c.sourceDiscountId));
  result.warnings = result.warnings.filter((w) => kept.has(w.sourceDiscountId));
  return result;
}
