import type Stripe from "stripe";

// ── Stripe intermediate types ──

export interface StripeProductWithPrices {
  product: Stripe.Product;
  prices: Stripe.Price[];
  hasOnetimePrices: boolean;
  hasRecurringPrices: boolean;
  isMixed: boolean;
}

// ── Mapper output types ──

export type PancakeBillingPeriod = "weekly" | "monthly" | "quarterly" | "yearly";

export type PancakeTaxCategory =
  | "digital_goods"
  | "saas"
  | "software"
  | "ebook"
  | "online_course"
  | "consulting"
  | "professional_service";

/** Matches SDK's PriceInfo: amount is display string (e.g. "9.99") */
export interface PancakePriceInfo {
  amount: string;
  taxCategory: PancakeTaxCategory;
}

export interface PancakeMediaItem {
  type: "image" | "video";
  url: string;
  alt?: string;
}

export interface PancakeProductInput {
  type: "onetime" | "subscription";
  name: string;
  description: string | null;
  prices: Record<string, PancakePriceInfo>;
  billingPeriod?: PancakeBillingPeriod;
  media: PancakeMediaItem[];
  metadata: Record<string, unknown>;
  stripeProductId: string;
  stripePriceIds: string[];
}

export interface MappingWarning {
  stripeProductId: string;
  stripeProductName: string;
  message: string;
  severity: "info" | "warn" | "error";
}

export interface SkippedItem {
  stripeId: string;
  stripeName: string;
  reason: string;
}

export interface MappingResult {
  products: PancakeProductInput[];
  warnings: MappingWarning[];
  skipped: SkippedItem[];
}

// ── Creator output types ──

export interface MigrationResult {
  input: PancakeProductInput;
  success: boolean;
  pancakeProductId?: string;
  error?: string;
}

// ── CLI options ──

export interface StripeCommandOptions {
  stripeKey?: string;
  merchantId?: string;
  privateKey?: string;
  storeId?: string;
  taxCategory?: PancakeTaxCategory;
  dryRun?: boolean;
  yes?: boolean;
  skipProducts?: boolean;
  skipWebhooks?: boolean;
  skipBranding?: boolean;
}

export interface CreemCommandOptions {
  apiKey?: string;
  merchantId?: string;
  privateKey?: string;
  storeId?: string;
  storeName?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export type MigrationSource = "stripe" | "creem";

export const TAX_CATEGORIES: PancakeTaxCategory[] = [
  "saas",
  "digital_goods",
  "software",
  "ebook",
  "online_course",
  "consulting",
  "professional_service",
];

// ── Currency utils ──

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** Convert Stripe's smallest-unit integer to display string ("9.99" or "1000" for JPY) */
export function centsToDisplay(amountInCents: number, currency: string): string {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return String(amountInCents);
  }
  return (amountInCents / 100).toFixed(2);
}
