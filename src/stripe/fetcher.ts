import Stripe from "stripe";
import { audit, registerSecret } from "../utils/audit.js";
import type { StripeProductWithPrices } from "../utils/types.js";
import { sourceStep } from "../utils/source-diagnostics.js";

function stripeClient(apiKey: string, step: string) {
  registerSecret(apiKey);
  const stripe = new Stripe(apiKey, { httpClient: Stripe.createFetchHttpClient() });
  let requestNumber = 0;
  stripe.on('response', response => audit('source.response', {
    source: 'stripe', step, requestNumber: ++requestNumber, path: response.path.split('?')[0],
    status: response.status, requestId: response.request_id, durationMs: response.elapsed,
  }));
  return stripe;
}

export async function fetchStripeProducts(
  apiKey: string
): Promise<StripeProductWithPrices[]> {
  const stripe = stripeClient(apiKey, 'products_and_prices');

  // Fetch all active products
  const products: Stripe.Product[] = [];
  await sourceStep('stripe', 'products', async () => {
    for await (const product of stripe.products.list({
      active: true,
      limit: 100,
    })) {
      products.push(product);
    }

    return products;
  });

  // Fetch all active prices
  const prices: Stripe.Price[] = [];
  await sourceStep('stripe', 'prices', async () => {
    for await (const price of stripe.prices.list({
      active: true,
      limit: 100,
    })) {
      prices.push(price);
    }

    return prices;
  });

  // Group prices by product ID
  const pricesByProduct = new Map<string, Stripe.Price[]>();
  for (const price of prices) {
    const productId =
      typeof price.product === "string" ? price.product : price.product.id;
    const existing = pricesByProduct.get(productId) ?? [];
    existing.push(price);
    pricesByProduct.set(productId, existing);
  }

  // Build result
  const result: StripeProductWithPrices[] = [];
  for (const product of products) {
    const productPrices = pricesByProduct.get(product.id) ?? [];
    if (productPrices.length === 0) continue;

    const hasOnetimePrices = productPrices.some((p) => p.type === "one_time");
    const hasRecurringPrices = productPrices.some((p) => p.type === "recurring");

    result.push({
      product,
      prices: productPrices,
      hasOnetimePrices,
      hasRecurringPrices,
      isMixed: hasOnetimePrices && hasRecurringPrices,
    });
  }

  return result;
}

// ── Account branding ──

export interface StripeBranding {
  businessName: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  supportUrl: string | null;
}

export async function fetchStripeBranding(
  apiKey: string
): Promise<StripeBranding> {
  const stripe = stripeClient(apiKey, 'branding');
  const account = await sourceStep('stripe', 'branding', () => stripe.accounts.retrieve());
  const bp = account.business_profile;

  return {
    businessName: bp?.name ?? null,
    supportEmail: bp?.support_email ?? null,
    supportPhone: bp?.support_phone ?? null,
    websiteUrl: bp?.url ?? null,
    supportUrl: bp?.support_url ?? null,
  };
}

// ── Webhook endpoints ──

export interface StripeWebhookEndpoint {
  id: string;
  url: string;
  enabledEvents: string[];
  status: string;
  description: string | null;
}

export async function fetchStripeWebhooks(
  apiKey: string
): Promise<StripeWebhookEndpoint[]> {
  const stripe = stripeClient(apiKey, 'webhooks');
  return sourceStep('stripe', 'webhooks', async () => {
    const endpoints: StripeWebhookEndpoint[] = [];

    for await (const wh of stripe.webhookEndpoints.list({ limit: 100 })) {
      endpoints.push({
        id: wh.id,
        url: wh.url,
        enabledEvents: wh.enabled_events,
        status: wh.status,
        description: wh.description ?? null,
    });
  }

  return endpoints;
  });
}
