import { audit, registerSecret } from "../utils/audit.js";
import { sourceStep, SourceShapeError } from "../utils/source-diagnostics.js";

export const LEMON_SQUEEZY_API = "https://api.lemonsqueezy.com";
const PAGE_SIZE = 100;
// A runaway paginator must stop instead of looping forever.
const MAX_PAGES = 1000;

export interface LemonSqueezyStore {
  id: string;
  name: string;
  currency: string;
}

// Only fields consumed by this migration. Validation keeps unknown values visible to the mapper.
export interface LemonSqueezyPrice {
  id: string;
  category: string;
  scheme: string;
  usage_aggregation: string | null;
  unit_price: number | null;
  setup_fee_enabled: boolean | null;
  renewal_interval_unit: string | null;
  renewal_interval_quantity: number | null;
  trial_interval_unit: string | null;
  trial_interval_quantity: number | null;
  tax_code: string | null;
}

export interface LemonSqueezyVariant {
  id: string;
  name: string;
  description: string | null;
  status: string;
  has_license_keys: boolean;
  /** Deprecated by Lemon Squeezy but still returned; used to confirm trial fields on the price. */
  has_free_trial?: boolean;
  test_mode: boolean;
  price: LemonSqueezyPrice | null;
}

export interface LemonSqueezyProduct {
  id: string;
  name: string;
  description: string | null;
  status: string;
  thumb_url: string | null;
  large_thumb_url: string | null;
  test_mode: boolean;
  variants: LemonSqueezyVariant[];
}

export interface LemonSqueezyDiscount {
  id: string;
  name: string;
  code: string;
  amount: number;
  amount_type: string;
  is_limited_to_products: boolean;
  is_limited_redemptions: boolean;
  max_redemptions: number | null;
  starts_at: string | null;
  expires_at: string | null;
  duration: string;
  duration_in_months: number | null;
  status: string;
  test_mode: boolean;
  /** Linked variants, read only for discounts limited to products. */
  variantIds: string[];
}

export interface LemonSqueezyCatalog {
  store: LemonSqueezyStore;
  products: LemonSqueezyProduct[];
  discounts: LemonSqueezyDiscount[];
}

interface Resource {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

/**
 * IDs of a to-many relationship included with `?include=` (JSON:API resource linkage,
 * as typed by the official lemonsqueezy.js SDK). `undefined` when no linkage was returned.
 */
function linkedIds(
  item: Resource,
  name: string,
  type: string
): string[] | undefined {
  const relationship = item.relationships?.[name];
  if (!isRecord(relationship) || relationship.data === undefined)
    return undefined;
  if (!Array.isArray(relationship.data))
    throw new SourceShapeError(`Invalid Lemon Squeezy ${name} linkage`);
  return relationship.data.map((link) => {
    if (!isRecord(link) || link.type !== type || typeof link.id !== "string")
      throw new SourceShapeError(`Invalid Lemon Squeezy ${name} linkage`);
    return link.id;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isOptionalString = (value: unknown) =>
  value == null || typeof value === "string";
const isOptionalNumber = (value: unknown) =>
  value == null || (typeof value === "number" && Number.isFinite(value));
const isOptionalBoolean = (value: unknown) =>
  value == null || typeof value === "boolean";

function requireFields(
  attributes: Record<string, unknown>,
  checks: Array<[string[], (value: unknown) => boolean]>,
  label: string
) {
  for (const [fields, check] of checks)
    for (const field of fields)
      if (!check(attributes[field]))
        throw new SourceShapeError(`Invalid Lemon Squeezy ${label} field`);
}

function toStore(item: Resource): LemonSqueezyStore {
  const a = item.attributes;
  if (typeof a.name !== "string" || typeof a.currency !== "string")
    throw new SourceShapeError("Invalid Lemon Squeezy store");
  return { id: item.id, name: a.name, currency: a.currency.toUpperCase() };
}

function toProduct(item: Resource, storeId: string): LemonSqueezyProduct {
  const a = item.attributes;
  if (String(a.store_id) !== storeId)
    throw new SourceShapeError(
      "Lemon Squeezy product belongs to another store"
    );
  requireFields(
    a,
    [
      [["name", "status"], (v) => typeof v === "string"],
      [["description", "thumb_url", "large_thumb_url"], isOptionalString],
      [["test_mode"], (v) => typeof v === "boolean"],
    ],
    "product"
  );
  return {
    id: item.id,
    name: a.name as string,
    description: (a.description as string | null) ?? null,
    status: a.status as string,
    thumb_url: (a.thumb_url as string | null) ?? null,
    large_thumb_url: (a.large_thumb_url as string | null) ?? null,
    test_mode: a.test_mode as boolean,
    variants: [],
  };
}

function toVariant(item: Resource, productId: string): LemonSqueezyVariant {
  const a = item.attributes;
  if (String(a.product_id) !== productId)
    throw new SourceShapeError(
      "Lemon Squeezy variant belongs to another product"
    );
  requireFields(
    a,
    [
      [["name", "status"], (v) => typeof v === "string"],
      [["description"], isOptionalString],
      [["test_mode"], (v) => typeof v === "boolean"],
      [["has_license_keys", "has_free_trial"], isOptionalBoolean],
    ],
    "variant"
  );
  return {
    id: item.id,
    name: a.name as string,
    description: (a.description as string | null) ?? null,
    status: a.status as string,
    has_license_keys: a.has_license_keys === true,
    has_free_trial: a.has_free_trial as boolean | undefined,
    test_mode: a.test_mode as boolean,
    price: null,
  };
}

function toPrice(item: Resource, variantId: string): LemonSqueezyPrice {
  const a = item.attributes;
  if (String(a.variant_id) !== variantId)
    throw new SourceShapeError(
      "Lemon Squeezy price belongs to another variant"
    );
  requireFields(
    a,
    [
      [["category", "scheme"], (v) => typeof v === "string"],
      [
        [
          "usage_aggregation",
          "renewal_interval_unit",
          "trial_interval_unit",
          "tax_code",
        ],
        isOptionalString,
      ],
      [
        ["unit_price", "renewal_interval_quantity", "trial_interval_quantity"],
        isOptionalNumber,
      ],
      [["setup_fee_enabled"], isOptionalBoolean],
    ],
    "price"
  );
  return {
    id: item.id,
    category: a.category as string,
    scheme: a.scheme as string,
    usage_aggregation: (a.usage_aggregation as string | null) ?? null,
    unit_price: (a.unit_price as number | null) ?? null,
    setup_fee_enabled: (a.setup_fee_enabled as boolean | null) ?? null,
    renewal_interval_unit: (a.renewal_interval_unit as string | null) ?? null,
    renewal_interval_quantity:
      (a.renewal_interval_quantity as number | null) ?? null,
    trial_interval_unit: (a.trial_interval_unit as string | null) ?? null,
    trial_interval_quantity:
      (a.trial_interval_quantity as number | null) ?? null,
    tax_code: (a.tax_code as string | null) ?? null,
  };
}

function toDiscount(item: Resource, storeId: string): LemonSqueezyDiscount {
  const a = item.attributes;
  if (String(a.store_id) !== storeId)
    throw new SourceShapeError(
      "Lemon Squeezy discount belongs to another store"
    );
  requireFields(
    a,
    [
      [
        ["name", "code", "amount_type", "duration", "status"],
        (v) => typeof v === "string",
      ],
      [["amount"], (v) => typeof v === "number" && Number.isFinite(v)],
      [
        ["is_limited_to_products", "is_limited_redemptions", "test_mode"],
        (v) => typeof v === "boolean",
      ],
      [["max_redemptions", "duration_in_months"], isOptionalNumber],
      [["starts_at", "expires_at"], isOptionalString],
    ],
    "discount"
  );
  return {
    id: item.id,
    name: a.name as string,
    code: a.code as string,
    amount: a.amount as number,
    amount_type: a.amount_type as string,
    is_limited_to_products: a.is_limited_to_products as boolean,
    is_limited_redemptions: a.is_limited_redemptions as boolean,
    max_redemptions: (a.max_redemptions as number | null) ?? null,
    starts_at: (a.starts_at as string | null) ?? null,
    expires_at: (a.expires_at as string | null) ?? null,
    duration: a.duration as string,
    duration_in_months: (a.duration_in_months as number | null) ?? null,
    status: a.status as string,
    test_mode: a.test_mode as boolean,
    variantIds: [],
  };
}

function client(apiKey: string) {
  if (!apiKey.trim()) throw new Error("Lemon Squeezy API key is required");
  registerSecret(apiKey);

  async function get(step: string, path: string, page: number) {
    audit("source.request", { source: "lemonsqueezy", step, path, page });
    const started = Date.now();
    const response = await fetch(`${LEMON_SQUEEZY_API}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    audit("source.response", {
      source: "lemonsqueezy",
      step,
      path,
      page,
      status: response.status,
      durationMs: Date.now() - started,
      requestId: response.headers.get("x-request-id"),
    });
    // Never include the response body or authentication headers in errors/logs.
    if (!response.ok)
      throw Object.assign(new Error("Lemon Squeezy request failed"), {
        status: response.status,
      });
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new SourceShapeError("Invalid Lemon Squeezy JSON");
    }
  }

  function resources(value: unknown, type: string): Resource[] {
    if (!isRecord(value) || !Array.isArray(value.data))
      throw new SourceShapeError("Expected Lemon Squeezy data array");
    return value.data.map((item) => {
      if (
        !isRecord(item) ||
        item.type !== type ||
        typeof item.id !== "string" ||
        !item.id ||
        !isRecord(item.attributes)
      )
        throw new SourceShapeError(`Invalid Lemon Squeezy ${type} resource`);
      return item as unknown as Resource;
    });
  }

  /** Follows page[number] until `links.next` disappears, as documented. */
  async function list(
    step: string,
    path: string,
    filters: Record<string, string>,
    type: string,
    include?: string
  ): Promise<Resource[]> {
    const items: Resource[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES)
        throw new SourceShapeError("Lemon Squeezy pagination did not end");
      const query = new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(filters).map(([k, v]) => [`filter[${k}]`, v])
        ),
        ...(include ? { include } : {}),
        "page[number]": String(page),
        "page[size]": String(PAGE_SIZE),
      });
      const result = await get(step, `${path}?${query}`, page);
      const data = resources(result, type);
      audit("source.page", {
        source: "lemonsqueezy",
        step,
        page,
        count: data.length,
      });
      for (const item of data) {
        if (seen.has(item.id))
          throw new SourceShapeError(
            "Repeated Lemon Squeezy ID; pagination may be unstable"
          );
        seen.add(item.id);
        items.push(item);
      }
      const links = isRecord(result) ? result.links : undefined;
      if (links !== undefined && !isRecord(links))
        throw new SourceShapeError("Invalid Lemon Squeezy links");
      if (!links?.next || data.length === 0) return items;
    }
  }

  /** Prices are ordered by created_at descending; the first is the variant's current price. */
  async function currentPrice(
    variantId: string
  ): Promise<LemonSqueezyPrice | null> {
    const query = new URLSearchParams({
      "filter[variant_id]": variantId,
      "page[number]": "1",
      "page[size]": "1",
    });
    const data = resources(
      await get("products", `/v1/prices?${query}`, 1),
      "prices"
    );
    return data.length ? toPrice(data[0], variantId) : null;
  }

  return { list, currentPrice };
}

export async function fetchLemonSqueezyStores(
  apiKey: string
): Promise<LemonSqueezyStore[]> {
  const api = client(apiKey);
  return sourceStep("lemonsqueezy", "stores", async () =>
    (await api.list("stores", "/v1/stores", {}, "stores")).map(toStore)
  );
}

export async function fetchLemonSqueezyCatalog(
  apiKey: string,
  store: LemonSqueezyStore,
  options: { discounts: boolean }
): Promise<LemonSqueezyCatalog> {
  const api = client(apiKey);
  const products = await sourceStep("lemonsqueezy", "products", async () => {
    const items = (
      await api.list(
        "products",
        "/v1/products",
        { store_id: store.id },
        "products"
      )
    ).map((item) => toProduct(item, store.id));
    for (const product of items) {
      const variants = await api.list(
        "products",
        "/v1/variants",
        { product_id: product.id },
        "variants"
      );
      for (const item of variants) {
        const variant = toVariant(item, product.id);
        variant.price = await api.currentPrice(variant.id);
        product.variants.push(variant);
      }
    }
    return items;
  });
  const discounts = !options.discounts
    ? []
    : await sourceStep("lemonsqueezy", "discounts", async () => {
        const resources = await api.list(
          "discounts",
          "/v1/discounts",
          { store_id: store.id },
          "discounts",
          "variants"
        );
        const items: LemonSqueezyDiscount[] = [];
        for (const item of resources) {
          const discount = toDiscount(item, store.id);
          if (discount.is_limited_to_products) {
            // Prefer the included linkage; fall back to the relationship's related route.
            discount.variantIds =
              linkedIds(item, "variants", "variants") ??
              (
                await api.list(
                  "discounts",
                  `/v1/discounts/${encodeURIComponent(discount.id)}/variants`,
                  {},
                  "variants"
                )
              ).map((variant) => variant.id);
          }
          items.push(discount);
        }
        return items;
      });
  return { store, products, discounts };
}
