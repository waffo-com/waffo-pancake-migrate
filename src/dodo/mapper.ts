import { CURRENCY_MINOR_UNITS } from "./currency.js";
import type { DodoProduct } from "./fetcher.js";
import type {
  MappingResult,
  PancakeBillingPeriod,
  PancakeTaxCategory,
} from "../utils/types.js";

const TAX_CATEGORIES: Record<string, PancakeTaxCategory | undefined> = {
  saas: "saas",
  digital_products: "digital_goods",
  e_book: "ebook",
  edtech: "online_course",
  // live_tutoring has no equivalent; never silently substitute a different tax category.
};
const PERIODS: Record<string, PancakeBillingPeriod | undefined> = {
  "Week:1": "weekly",
  "Month:1": "monthly",
  "Month:3": "quarterly",
  "Month:12": "yearly",
  "Year:1": "yearly",
};

/** ISO currency minor units, without binary floating-point rounding. */
export function dodoAmountToDisplay(
  amount: unknown,
  currency: unknown
): string {
  if (typeof currency !== "string" || !CURRENCY_MINOR_UNITS.has(currency))
    throw new Error("Unsupported currency");
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)
    throw new Error("Invalid minor-unit amount");
  const digits = CURRENCY_MINOR_UNITS.get(currency)!;
  const value = String(amount).padStart(digits + 1, "0");
  return digits === 0
    ? value
    : `${value.slice(0, -digits)}.${value.slice(-digits)}`;
}

export function mapDodoProducts(source: DodoProduct[]): MappingResult {
  const result: MappingResult = { products: [], warnings: [], skipped: [] };
  for (const p of source) {
    const name = p.name || p.product_id;
    const warn = (message: string) =>
      result.warnings.push({
        sourceProductId: p.product_id,
        sourceProductName: name,
        message,
        severity: "warn",
      });
    try {
      if (typeof p.name !== "string" || !p.name.trim())
        throw new Error("Missing product name");
      const price = p.price;
      if (price.type !== "one_time_price" && price.type !== "recurring_price")
        throw new Error(`Unsupported price type: ${String(price.type)}`);
      const taxCategory = Object.hasOwn(TAX_CATEGORIES, p.tax_category)
        ? TAX_CATEGORIES[p.tax_category]
        : undefined;
      if (!taxCategory)
        throw new Error(`Unsupported tax category: ${p.tax_category}`);
      if (price.pay_what_you_want)
        throw new Error("Unsupported pay-what-you-want pricing");
      if (price.purchasing_power_parity || p.pricing_mode)
        throw new Error(
          "Unsupported purchasing power parity or localized pricing"
        );
      if ((price.discount_bps ?? price.discount ?? 0) !== 0)
        throw new Error("Unsupported price discount");
      if (
        (price.trial_period_days ?? 0) !== 0 ||
        (price.trial_amount ?? 0) !== 0
      )
        throw new Error("Unsupported trial pricing");
      if (
        price.zero_amount_payment_method_optional ||
        price.trial_payment_method_optional
      )
        throw new Error("Unsupported optional payment method configuration");
      if (p.addons?.length) throw new Error("Unsupported subscription addons");
      if (
        price.tax_inclusive != null &&
        typeof price.tax_inclusive !== "boolean"
      )
        throw new Error("Invalid tax_inclusive value");
      const amount = dodoAmountToDisplay(price.price, price.currency);
      let billingPeriod: PancakeBillingPeriod | undefined;
      if (price.type === "recurring_price") {
        if (!Number.isInteger(price.payment_frequency_count))
          throw new Error("Invalid payment frequency count");
        billingPeriod =
          PERIODS[
            `${price.payment_frequency_interval}:${price.payment_frequency_count}`
          ];
        if (!billingPeriod)
          throw new Error(
            `Unsupported payment frequency: ${price.payment_frequency_count} ${price.payment_frequency_interval}`
          );
        warn(
          "Subscription duration is preserved in metadata only; Waffo subscriptions do not inherit Dodo end dates."
        );
      }
      if (price.tax_inclusive !== false) {
        warn(
          `Tax-inclusive setting: ${price.tax_inclusive === true ? "true" : "unspecified"}. Preserved in metadata, not applied by Waffo; review destination tax behavior and pass --acknowledge-tax-semantics before writing.`
        );
      }
      if (
        p.credit_entitlements?.length ||
        p.entitlements?.length ||
        p.license_key_enabled ||
        p.digital_product_delivery
      ) {
        warn(
          "Entitlements, license keys and delivery are outside catalog migration and require separate integration."
        );
      }
      result.products.push({
        type: price.type === "one_time_price" ? "onetime" : "subscription",
        name: p.name,
        description: p.description || null,
        billingPeriod,
        prices: { [price.currency as string]: { amount, taxCategory } },
        media: p.image ? [{ type: "image", url: p.image }] : [],
        metadata: {
          ...p.metadata,
          _dodoProductId: p.product_id,
          _dodoTaxCategory: p.tax_category,
          _dodoTaxInclusive: price.tax_inclusive ?? "unspecified",
          ...(price.type === "recurring_price"
            ? {
                _dodoSubscriptionPeriodCount:
                  price.subscription_period_count ?? null,
                _dodoSubscriptionPeriodInterval:
                  price.subscription_period_interval ?? null,
              }
            : {}),
        },
        sourceProductId: p.product_id,
        sourcePriceIds: [p.product_id],
      });
    } catch (error) {
      result.skipped.push({
        sourceProductId: p.product_id,
        sourceProductName: name,
        reason:
          error instanceof Error ? error.message : "Unsupported configuration",
      });
    }
  }
  return result;
}
