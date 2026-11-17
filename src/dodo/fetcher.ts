import { audit, registerSecret } from "../utils/audit.js";
import { sourceStep, SourceShapeError } from "../utils/source-diagnostics.js";

export type DodoEnvironment = "test" | "live";
// Only fields consumed by this migration; unknown price variants remain visible to the mapper.
export interface DodoProduct {
  product_id: string;
  name?: string | null;
  description?: string | null;
  image?: string | null;
  tax_category: string;
  price: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  credit_entitlements?: unknown[];
  entitlements?: unknown[];
  addons?: string[] | null;
  license_key_enabled?: boolean;
  digital_product_delivery?: unknown;
  pricing_mode?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): boolean {
  return value == null || typeof value === "boolean";
}

// Validate transport shapes here; supported prices, amounts and periods are the mapper's responsibility.
function validateProduct(
  value: unknown,
  expectedId: string
): asserts value is DodoProduct {
  if (
    !isRecord(value) ||
    value.product_id !== expectedId ||
    typeof value.tax_category !== "string" ||
    !isRecord(value.price) ||
    typeof value.price.type !== "string" ||
    !value.price.type
  ) {
    throw new SourceShapeError("Invalid Dodo product detail");
  }
  for (const field of ["name", "description", "image", "pricing_mode"]) {
    if (!isOptionalString(value[field]))
      throw new SourceShapeError("Invalid Dodo text field");
  }
  if (
    value.metadata !== undefined &&
    (!isRecord(value.metadata) ||
      !Object.values(value.metadata).every(
        (item) =>
          typeof item === "string" ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item))
      ))
  ) {
    throw new SourceShapeError("Invalid Dodo metadata");
  }
  for (const field of ["credit_entitlements", "entitlements"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new SourceShapeError("Invalid Dodo entitlement list");
    }
  }
  if (
    value.addons != null &&
    (!Array.isArray(value.addons) ||
      !value.addons.every((item) => typeof item === "string"))
  ) {
    throw new SourceShapeError("Invalid Dodo addon list");
  }
  if (
    value.license_key_enabled !== undefined &&
    typeof value.license_key_enabled !== "boolean"
  ) {
    throw new SourceShapeError("Invalid Dodo license flag");
  }
  const price = value.price;
  // Unknown price variants remain intact so the preview can report them as unsupported.
  if (price.type !== "one_time_price" && price.type !== "recurring_price")
    return;
  if (
    typeof price.currency !== "string" ||
    typeof price.price !== "number" ||
    !Number.isFinite(price.price)
  ) {
    throw new SourceShapeError("Invalid Dodo price fields");
  }
  for (const field of [
    "tax_inclusive",
    "pay_what_you_want",
    "purchasing_power_parity",
    "trial_payment_method_optional",
    "zero_amount_payment_method_optional",
  ]) {
    if (!isOptionalBoolean(price[field]))
      throw new SourceShapeError("Invalid Dodo price flag");
  }
  for (const field of [
    "discount",
    "discount_bps",
    "trial_period_days",
    "trial_amount",
  ]) {
    if (!isOptionalNumber(price[field]))
      throw new SourceShapeError("Invalid Dodo numeric price field");
  }
  if (
    price.type === "recurring_price" &&
    (typeof price.payment_frequency_count !== "number" ||
      !Number.isFinite(price.payment_frequency_count) ||
      typeof price.payment_frequency_interval !== "string" ||
      !isOptionalNumber(price.subscription_period_count) ||
      !isOptionalString(price.subscription_period_interval))
  ) {
    throw new SourceShapeError("Invalid Dodo recurring price fields");
  }
}

export const DODO_BASE_URLS = {
  test: "https://test.dodopayments.com",
  live: "https://live.dodopayments.com",
} as const;

export async function fetchDodoProducts(
  apiKey: string,
  environment: DodoEnvironment
): Promise<DodoProduct[]> {
  if (environment !== "test" && environment !== "live")
    throw new Error("Dodo environment must be test or live");
  if (!apiKey.trim()) throw new Error("Dodo API key is required");
  registerSecret(apiKey);
  return sourceStep("dodo", "products", async () => {
    async function get(path: string, page: number): Promise<unknown> {
      audit("source.request", { source: "dodo", step: "products", path, page });
      const started = Date.now();
      const response = await fetch(`${DODO_BASE_URLS[environment]}${path}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      audit("source.response", {
        source: "dodo",
        step: "products",
        path,
        page,
        status: response.status,
        durationMs: Date.now() - started,
        requestId: response.headers.get("x-request-id"),
      });
      // Never include the response body or authentication headers in errors/logs.
      if (!response.ok)
        throw Object.assign(new Error("Dodo request failed"), {
          status: response.status,
        });
      try {
        return await response.json();
      } catch {
        throw new SourceShapeError("Invalid Dodo JSON");
      }
    }

    const products: DodoProduct[] = [];
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      const result = await get(
        `/products?page_number=${page}&page_size=100&archived=false`,
        page
      );
      if (!isRecord(result) || !Array.isArray(result.items))
        throw new SourceShapeError("Expected Dodo items array");
      audit("source.page", {
        source: "dodo",
        step: "products",
        page,
        count: result.items.length,
      });
      // The official paginator continues until an empty page, including after short pages.
      if (result.items.length === 0) break;
      for (const item of result.items) {
        const id = isRecord(item) ? item.product_id : undefined;
        if (typeof id !== "string" || !id || seen.has(id)) {
          throw new SourceShapeError(
            "Missing or repeated Dodo product ID; pagination may be unstable"
          );
        }
        seen.add(id);
        const product = await get(`/products/${encodeURIComponent(id)}`, page);
        validateProduct(product, id);
        products.push(product);
      }
    }
    return products;
  });
}
