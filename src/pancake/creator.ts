import { pancakeClient, query, readBack } from "./client.js";
import { audit, redact } from "../utils/audit.js";
import { BillingPeriod, TaxCategory } from "@waffo/pancake-ts";
import type { Prices } from "@waffo/pancake-ts";
import type { PancakeProductInput, MigrationResult, PancakePriceInfo } from "../utils/types.js";

const BILLING_PERIOD_MAP: Record<string, BillingPeriod> = {
  weekly: BillingPeriod.Weekly,
  monthly: BillingPeriod.Monthly,
  quarterly: BillingPeriod.Quarterly,
  yearly: BillingPeriod.Yearly,
};

const TAX_CATEGORY_MAP: Record<string, TaxCategory> = {
  digital_goods: TaxCategory.DigitalGoods,
  saas: TaxCategory.SaaS,
  software: TaxCategory.Software,
  ebook: TaxCategory.Ebook,
  online_course: TaxCategory.OnlineCourse,
  consulting: TaxCategory.Consulting,
  professional_service: TaxCategory.ProfessionalService,
};

function toSdkPrices(prices: Record<string, PancakePriceInfo>): Prices {
  const result: Prices = {};
  for (const [currency, info] of Object.entries(prices)) {
    result[currency] = {
      amount: info.amount,
      taxCategory: TAX_CATEGORY_MAP[info.taxCategory] ?? TaxCategory.DigitalGoods,
    };
  }
  return result;
}

export interface CreateOptions {
  products: PancakeProductInput[];
  merchantId: string;
  privateKey: string;
  storeId: string;
  onProgress?: (completed: number, total: number) => void;
}

export async function createPancakeProducts(
  options: CreateOptions
): Promise<MigrationResult[]> {
  const { products, merchantId, privateKey, storeId, onProgress } = options;

  const client = pancakeClient(merchantId, privateKey);

  await verifyPancakeStore(merchantId, privateKey, storeId);
  const results: MigrationResult[] = [];

  for (let i = 0; i < products.length; i++) {
    const input = products[i];
    let productId: string | undefined;
    try {
      if (input.type === "onetime") {
        const { product } = await client.onetimeProducts.create({
          storeId,
          name: input.name,
          description: input.description ?? undefined,
          prices: toSdkPrices(input.prices),
          media: input.media.length > 0 ? input.media : undefined,
          metadata: input.metadata,
        });

        productId = product.id;
      } else {
        const { product } = await client.subscriptionProducts.create({
          storeId,
          name: input.name,
          billingPeriod: BILLING_PERIOD_MAP[input.billingPeriod!],
          description: input.description ?? undefined,
          prices: toSdkPrices(input.prices),
          media: input.media.length > 0 ? input.media : undefined,
          metadata: input.metadata,
        });

        productId = product.id;
      }
      audit("product.created", { storeId, productId, name: input.name, sourceProductId: input.stripeProductId });
      const verified = await verifyPancakeProduct(merchantId, privateKey, storeId, productId!, input);
      results.push({ input, success: true, pancakeProductId: productId, hasProdVersion: verified.hasProdVersion });
    } catch (err) {
      audit(productId ? "product.unverified" : "product.failed", { storeId, productId, name: input.name, error: redact(err instanceof Error ? err.message : String(err)) });
      results.push({
        input,
        success: false,
        pancakeProductId: productId,
        error: redact(err instanceof Error ? err.message : String(err)),
      });
    }

    onProgress?.(i + 1, products.length);
  }

  return results;
}

export async function listPancakeStores(
  merchantId: string,
  privateKey: string
): Promise<Array<{ id: string; name: string; status: string }>> {
  const client = pancakeClient(merchantId, privateKey);

  const stores: Array<{ id: string; name: string; status: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const result = await query<{ stores: typeof stores }>(client,
      `query ($offset: Int!) { stores(limit: 100, offset: $offset) { id name status } }`, { offset });
    if (!Array.isArray(result.stores)) throw new Error("Invalid Pancake stores response");
    stores.push(...result.stores);
    if (result.stores.length < 100) return stores;
  }
}

// ── Store creation ──

export async function createPancakeStore(
  merchantId: string,
  privateKey: string,
  name: string
): Promise<{ id: string; name: string }> {
  const client = pancakeClient(merchantId, privateKey);
  const { store } = await client.stores.create({ name });
  audit("store.created", { merchantId, storeId: store.id, name });
  await verifyPancakeStore(merchantId, privateKey, store.id, name);
  return { id: store.id, name: store.name };
}

// ── Webhook migration ──

/** Map Stripe webhook events to closest Pancake equivalents */
const STRIPE_TO_PANCAKE_EVENTS: Record<string, string> = {
  "checkout.session.completed": "order.completed",
  "customer.subscription.created": "subscription.activated",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.canceled",
  "invoice.payment_succeeded": "subscription.payment_succeeded",
  "invoice.payment_failed": "subscription.past_due",
  "charge.refunded": "refund.succeeded",
};

export interface WebhookMigrationResult {
  success: boolean;
  url: string | null;
  events: string[];
  unmappedEvents: string[];
  error?: string;
}

export async function migrateWebhooks(options: {
  merchantId: string;
  privateKey: string;
  storeId: string;
  stripeWebhookUrl: string;
  stripeEvents: string[];
  isTestKey: boolean;
}): Promise<WebhookMigrationResult> {
  const { merchantId, privateKey, storeId, stripeWebhookUrl, stripeEvents, isTestKey } = options;

  // Map events
  const mappedEvents = new Set<string>();
  const unmappedEvents: string[] = [];
  for (const event of stripeEvents) {
    const pancakeEvent = STRIPE_TO_PANCAKE_EVENTS[event];
    if (pancakeEvent) {
      mappedEvents.add(pancakeEvent);
    } else {
      unmappedEvents.push(event);
    }
  }

  const events = Array.from(mappedEvents);
  const client = pancakeClient(merchantId, privateKey);

  try {
    await client.stores.update({
      id: storeId,
      webhookSettings: isTestKey
        ? { testWebhookUrl: stripeWebhookUrl, testEvents: events }
        : { prodWebhookUrl: stripeWebhookUrl, prodEvents: events },
    });

    return { success: true, url: stripeWebhookUrl, events, unmappedEvents };
  } catch (err) {
    return {
      success: false,
      url: stripeWebhookUrl,
      events,
      unmappedEvents,
      error: redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

// ── Store branding migration ──

export interface BrandingMigrationResult {
  success: boolean;
  fields: Record<string, string | null>;
  error?: string;
}

export async function migrateStoreBranding(options: {
  merchantId: string;
  privateKey: string;
  storeId: string;
  supportEmail: string | null;
  website: string | null;
}): Promise<BrandingMigrationResult> {
  const { merchantId, privateKey, storeId, supportEmail, website } = options;

  const client = pancakeClient(merchantId, privateKey);
  const fields: Record<string, string | null> = {};

  try {
    const updateParams: { id: string; supportEmail?: string; website?: string } = { id: storeId };

    if (supportEmail) {
      updateParams.supportEmail = supportEmail;
      fields.supportEmail = supportEmail;
    }
    if (website) {
      updateParams.website = website;
      fields.website = website;
    }

    if (Object.keys(fields).length === 0) {
      return { success: true, fields };
    }

    await client.stores.update(updateParams);
    return { success: true, fields };
  } catch (err) {
    return {
      success: false,
      fields,
      error: redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function verifyPancakeStore(merchantId: string, privateKey: string, storeId: string, expectedName?: string) {
  const client = pancakeClient(merchantId, privateKey);
  return readBack(async () => {
    const { store } = await query<{ store: { id: string; name: string; status: string } | null }>(client,
      `query ($id: String!) { store(id: $id) { id name status } }`, { id: storeId });
    if (!store || store.id !== storeId || (expectedName !== undefined && store.name !== expectedName)) {
      throw new Error(`Store ${storeId} could not be verified (missing, inaccessible or name mismatch). Migration stopped; do not recreate blindly.`);
    }
    audit("store.verified", { merchantId, storeId, name: store.name });
    return store;
  });
}

export async function verifyPancakeProduct(merchantId: string, privateKey: string, storeId: string, productId: string, input: PancakeProductInput) {
  const client = pancakeClient(merchantId, privateKey);
  const field = input.type === "onetime" ? "onetimeProduct" : "subscriptionProduct";
  return readBack(async () => {
    const data = await query<Record<string, { id: string; storeId: string; name: string; status: string; billingPeriod?: string; hasProdVersion: boolean; prices: Array<{ currency: string; priceInfo: PancakePriceInfo }> } | null>>(client,
      `query ($id: String!) { ${field}(id: $id) { id storeId name status hasProdVersion ${input.type === "subscription" ? "billingPeriod" : ""} prices { currency priceInfo { amount taxCategory } } } }`, { id: productId });
    const p = data[field];
    const expected = Object.entries(input.prices);
    const priceMatches = p && Array.isArray(p.prices) && p.prices.length === expected.length && expected.every(([currency, price]) =>
      p.prices.some(actual => actual.currency === currency && Number.isFinite(Number(actual.priceInfo.amount)) && Number(actual.priceInfo.amount) === Number(price.amount) && actual.priceInfo.taxCategory === price.taxCategory));
    if (!p || p.id !== productId || p.storeId !== storeId || p.name !== input.name || p.status !== "active" || typeof p.hasProdVersion !== "boolean" || !priceMatches || (input.type === "subscription" && p.billingPeriod !== input.billingPeriod)) {
      throw new Error(`Product ${productId} was returned by create but read-back verification failed (visibility, store, name, status, price or billing period). Do not recreate blindly.`);
    }
    audit("product.verified", { storeId, productId, name: p.name, hasProdVersion: p.hasProdVersion });
    return p;
  });
}
