import { WaffoPancake, BillingPeriod, TaxCategory } from "@waffo/pancake-ts";
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

  const client = new WaffoPancake({ merchantId, privateKey });

  const results: MigrationResult[] = [];

  for (let i = 0; i < products.length; i++) {
    const input = products[i];
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

        results.push({
          input,
          success: true,
          pancakeProductId: product.id,
        });
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

        results.push({
          input,
          success: true,
          pancakeProductId: product.id,
        });
      }
    } catch (err) {
      results.push({
        input,
        success: false,
        error: err instanceof Error ? err.message : String(err),
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
  const client = new WaffoPancake({ merchantId, privateKey });

  const result = await client.graphql.query<{
    stores: Array<{ id: string; name: string; status: string }>;
  }>({
    query: `query { stores { id name status } }`,
  });

  return result.data?.stores ?? [];
}

// ── Store creation ──

export async function createPancakeStore(
  merchantId: string,
  privateKey: string,
  name: string
): Promise<{ id: string; name: string }> {
  const client = new WaffoPancake({ merchantId, privateKey });
  const { store } = await client.stores.create({ name });
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
  const client = new WaffoPancake({ merchantId, privateKey });

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
      error: err instanceof Error ? err.message : String(err),
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

  const client = new WaffoPancake({ merchantId, privateKey });
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
