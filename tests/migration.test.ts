import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPancakeProducts,
  createPancakeStore,
  listPancakeStores,
} from "../src/pancake/creator.js";
import {
  startAudit,
  audit,
  endAudit,
  registerSecret,
} from "../src/utils/audit.js";
import { spinner, stopSpinners } from "../src/utils/spinner.js";
import {
  sourceStep,
  validateCreemPage,
} from "../src/utils/source-diagnostics.js";
import {
  fetchStripeProducts,
  fetchStripeWebhooks,
} from "../src/stripe/fetcher.js";
import { PassThrough } from "node:stream";
import { createCli } from "../src/cli.js";
import { ensureTaxAcknowledged } from "../src/utils/migration.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const merchantId = "MER_" + "1".repeat(22),
  storeId = "STO_" + "2".repeat(22),
  productId = "PROD_" + "3".repeat(22);
const store = { id: storeId, name: "Test store", status: "active" };
const input = {
  type: "onetime" as const,
  name: "Credits",
  description: null,
  prices: { USD: { amount: "19.90", taxCategory: "digital_goods" as const } },
  media: [],
  metadata: {},
  sourceProductId: "source",
  sourcePriceIds: ["source"],
};
const product = {
  id: productId,
  storeId,
  name: input.name,
  status: "active",
  hasProdVersion: false,
  prices: [{ currency: "USD", priceInfo: input.prices.USD }],
};
after(() => rmSync(dir, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), "migration-tests-"));
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exitCode = 0;
  stopSpinners();
  endAudit();
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json", "x-request-id": "req-test" },
  });
function mockApi(
  options: {
    missingStore?: boolean;
    mismatch?: boolean;
    delayed?: boolean;
    nested?: boolean;
    rejectCreate?: boolean;
    wrongPrice?: boolean;
    wrongPeriod?: boolean;
  } = {}
) {
  const calls: string[] = [];
  let reads = 0;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push(path);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("/create-store")) return response({ store });
    if (path.endsWith("/create-product")) {
      if (options.rejectCreate) return new Response("{}", { status: 500 });
      return response({ product: { id: productId } });
    }
    let data;
    if (body.query.includes("stores(")) data = { stores: [store] };
    else if (body.query.includes("store(id:"))
      data = { store: options.missingStore ? null : store };
    else {
      reads++;
      data = {
        [body.query.includes("subscriptionProduct(")
          ? "subscriptionProduct"
          : "onetimeProduct"]:
          options.delayed && reads === 1
            ? null
            : {
                ...product,
                billingPeriod: options.wrongPeriod ? "yearly" : "monthly",
                prices: options.wrongPrice
                  ? [
                      {
                        currency: "USD",
                        priceInfo: { ...input.prices.USD, amount: "1.00" },
                      },
                    ]
                  : product.prices,
                storeId: options.mismatch ? "wrong" : storeId,
              },
      };
    }
    return response(options.nested ? { data } : data);
  };
  return calls;
}
test("store list accepts the actual unwrapped SDK response and nested response", async () => {
  for (const nested of [false, true]) {
    mockApi({ nested });
    assert.deepEqual(await listPancakeStores(merchantId, privateKey), [store]);
  }
});
test("missing store prevents all product writes", async () => {
  const calls = mockApi({ missingStore: true });
  await assert.rejects(
    createPancakeProducts({
      merchantId,
      privateKey,
      storeId,
      products: [input],
    }),
    /could not be verified/
  );
  assert.equal(
    calls.some((c) => c.endsWith("/create-product")),
    false
  );
});
test("created but invisible store stops before migrating", async () => {
  const calls = mockApi({ missingStore: true });
  await assert.rejects(
    createPancakeStore(merchantId, privateKey, store.name),
    /could not be verified/
  );
  assert.equal(calls.filter((c) => c.endsWith("/create-store")).length, 1);
});
test("product read-back mismatch retains ID and reports unverified", async () => {
  mockApi({ mismatch: true });
  const [result] = await createPancakeProducts({
    merchantId,
    privateKey,
    storeId,
    products: [input],
  });
  assert.equal(result.success, false);
  assert.equal(result.pancakeProductId, productId);
  assert.match(result.error!, /read-back/);
});
test("eventual consistency retries reads, never creates again", async () => {
  const calls = mockApi({ delayed: true });
  const [result] = await createPancakeProducts({
    merchantId,
    privateKey,
    storeId,
    products: [input],
  });
  assert.equal(result.success, true);
  assert.equal(result.hasProdVersion, false);
  assert.equal(calls.filter((c) => c.endsWith("/create-product")).length, 1);
});
test("HTTP failure is never reported as successful creation", async () => {
  mockApi({ rejectCreate: true });
  const [result] = await createPancakeProducts({
    merchantId,
    privateKey,
    storeId,
    products: [input],
  });
  assert.equal(result.success, false);
  assert.equal(result.pancakeProductId, undefined);
  assert.match(result.error!, /HTTP 500/);
});
test("audit redacts credentials and excludes request bodies and headers", async () => {
  const file = startAudit(join(dir, "redacted.jsonl"));
  registerSecret(privateKey);
  registerSecret("secret-token");
  audit("test", {
    error: `${privateKey} secret-token creem_abc sk_live_abc`,
    body: privateKey,
    headers: { Authorization: "secret-token" },
  });
  mockApi();
  await createPancakeProducts({
    merchantId,
    privateKey,
    storeId,
    products: [input],
  });
  const text = readFileSync(file, "utf8");
  for (const secret of [
    privateKey,
    "secret-token",
    "creem_abc",
    "sk_live_abc",
    "Authorization",
    "PRIVATE KEY",
  ])
    assert.equal(text.includes(secret), false);
  assert.match(text, /product.verified/);
  assert.match(text, /req-test/);
  assert.throws(() => startAudit(file), /EEXIST/);
});
function creemMock(options: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi(options);
  const pancakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = url instanceof Request ? url.url : String(url);
    if (!href.includes("creem.io")) return pancakeFetch(url, init);
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "prod_source",
            mode: "prod",
            object: "product",
            name: "Credits",
            description: "",
            price: 1990,
            currency: "USD",
            billing_type: "onetime",
            billing_period: "once",
            status: "active",
            tax_mode: "exclusive",
            tax_category: "digital-goods-service",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        pagination: {
          total_records: 1,
          total_pages: 1,
          current_page: 1,
          next_page: null,
          prev_page: null,
        },
      }),
      { headers: { "content-type": "application/json" } }
    );
  };
  return calls;
}
async function cli(name: string, extra: string[] = []) {
  await createCli().parseAsync(
    [
      "creem",
      "--api-key",
      "creem_fake",
      "--merchant-id",
      merchantId,
      "--private-key",
      privateKey,
      "--store-id",
      "new",
      "--store-name",
      store.name,
      "--yes",
      "--log-file",
      join(dir, name + ".jsonl"),
      ...extra,
    ],
    { from: "user" }
  );
  return readFileSync(join(dir, name + ".jsonl"), "utf8");
}
test("full Creem CLI new-store flow creates then verifies store and product", async () => {
  const calls = creemMock();
  const log = await cli("cli-success");
  assert.notEqual(process.exitCode, 1);
  assert.match(log, /store.created/);
  assert.match(log, /product.verified/);
  assert.match(log, /migration.finished/);
  assert.equal(calls.filter((c) => c.endsWith("/create-store")).length, 1);
});
test("full CLI dry-run never writes a store or product", async () => {
  const calls = creemMock();
  await cli("cli-dry", ["--dry-run"]);
  assert.equal(calls.length, 0);
  assert.notEqual(process.exitCode, 1);
});
test("full CLI reports nonzero exit on product verification failure", async () => {
  creemMock({ mismatch: true });
  const log = await cli("cli-fail");
  assert.equal(process.exitCode, 1);
  assert.match(log, /"failed":1/);
});
test("full CLI stops on invisible newly created store", async () => {
  const calls = creemMock({ missingStore: true });
  const log = await cli("cli-store-fail");
  assert.equal(process.exitCode, 1);
  assert.match(log, /migration.failed/);
  assert.equal(
    calls.some((c) => c.endsWith("/create-product")),
    false
  );
});

test("price and subscription billing-period mismatches fail verification", async () => {
  for (const options of [{ wrongPrice: true }, { wrongPeriod: true }]) {
    mockApi(options);
    const [result] = await createPancakeProducts({
      merchantId,
      privateKey,
      storeId,
      products: [{ ...input, type: "subscription", billingPeriod: "monthly" }],
    });
    assert.equal(result.success, false);
    assert.equal(result.pancakeProductId, productId);
  }
});

test("Stripe branding fetch failure produces nonzero exit even with no writes", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { message: "denied", type: "invalid_request_error" },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  await createCli().parseAsync(
    [
      "stripe",
      "--stripe-key",
      "sk_test_fake",
      "--merchant-id",
      merchantId,
      "--private-key",
      privateKey,
      "--store-id",
      storeId,
      "--tax-category",
      "saas",
      "--skip-products",
      "--skip-webhooks",
      "--yes",
      "--log-file",
      join(dir, "stripe-failure.jsonl"),
    ],
    { from: "user" }
  );
  assert.equal(process.exitCode, 1);
  const log = readFileSync(join(dir, "stripe-failure.jsonl"), "utf8");
  assert.match(log, /source.failed/);
  assert.match(log, /\"step\":\"branding\"/);
  assert.match(log, /\"status\":400/);
});

test("stale successful GraphQL response cannot validate a missing store", async () => {
  let creates = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/create-store")) {
      creates++;
      return response({ store });
    }
    const headers = new Headers(init?.headers);
    // Reproduce the gateway replay: old reads say active; current state is absent.
    return response({ store: headers.has("X-Idempotency-Key") ? store : null });
  };
  await assert.rejects(
    createPancakeStore(merchantId, privateKey, store.name),
    /create response may have been replayed/
  );
  assert.equal(
    creates,
    1,
    "verification failure must not silently create another store"
  );
});

test("fresh reads observe store deletion rather than replaying the first response", async () => {
  let exists = true;
  const cached = new Map<string, unknown>();
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const key = headers.get("X-Idempotency-Key");
    const current = { stores: exists ? [store] : [] };
    if (key && cached.has(key)) return response(cached.get(key));
    if (key) cached.set(key, current);
    return response(current);
  };
  assert.equal((await listPancakeStores(merchantId, privateKey)).length, 1);
  exists = false;
  assert.deepEqual(await listPancakeStores(merchantId, privateKey), []);
});

test("explicit creation ID survives a lost response without duplicate stores", async () => {
  const keys: string[] = [];
  const created = new Map<string, typeof store>();
  let loseResponse = true;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith("/create-store")) {
      const key = headers.get("X-Idempotency-Key")!;
      assert.ok(key);
      keys.push(key);
      if (!created.has(key))
        created.set(key, {
          ...store,
          id: "STO_" + String(created.size + 4).repeat(22),
        });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after store was created");
      }
      return response({ store: created.get(key) });
    }
    assert.equal(headers.has("X-Idempotency-Key"), false);
    assert.ok(headers.get("X-Signature"), "authentication is preserved");
    const { variables } = JSON.parse(String(init?.body));
    return response({
      store: [...created.values()].find((s) => s.id === variables.id) ?? null,
    });
  };
  await assert.rejects(
    createPancakeStore(merchantId, privateKey, store.name, "operation-a"),
    /response lost/
  );
  const first = await createPancakeStore(
    merchantId,
    privateKey,
    store.name,
    "operation-a"
  );
  assert.equal(created.size, 1);
  assert.equal(keys[0], keys[1]);
  const second = await createPancakeStore(
    merchantId,
    privateKey,
    store.name,
    "operation-b"
  );
  assert.equal(created.size, 2);
  assert.notEqual(first.id, second.id);
  assert.notEqual(keys[1], keys[2]);
});

test("CLI forwards explicit store creation ID and keeps product retry keys stable", async () => {
  creemMock();
  const base = globalThis.fetch;
  const storeKeys: string[] = [],
    productKeys: string[] = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith("/create-store"))
      storeKeys.push(headers.get("X-Idempotency-Key")!);
    if (String(url).endsWith("/create-product"))
      productKeys.push(headers.get("X-Idempotency-Key")!);
    return base(url, init);
  };
  await cli("operation-a1", ["--store-creation-id", "a"]);
  await cli("operation-a2", ["--store-creation-id", "a"]);
  await cli("operation-b", ["--store-creation-id", "b"]);
  assert.equal(storeKeys[0], storeKeys[1]);
  assert.notEqual(storeKeys[0], storeKeys[2]);
  assert.equal(new Set(productKeys).size, 1);
});

test("audit redacts multiline bare private keys before JSON escaping", () => {
  const bareKey = privateKey.replace(/-----[^\n]+-----/g, "").trim();
  const quotedSecret = 'secret-with-"quotes"\nand-newlines';
  registerSecret(bareKey);
  registerSecret(quotedSecret);
  const file = startAudit(join(dir, "multiline-secret.jsonl"));
  audit("test", {
    error: `failure: ${bareKey} ${quotedSecret}`,
    message: { privateKey },
  });
  const contents = readFileSync(file, "utf8");
  for (const line of bareKey.split("\n"))
    assert.equal(contents.includes(line), false);
  const entry = JSON.parse(contents.trim().split("\n").at(-1)!);
  assert.equal(entry.error, "failure: [REDACTED] [REDACTED]");
  assert.equal(entry.message, undefined);
});

test("CLI exception stops enabled spinner timers before returning failure", async () => {
  const stream = new PassThrough();
  stream.resume();
  const indicator = spinner({
    text: "request in progress",
    stream,
    isEnabled: true,
    discardStdin: false,
    hideCursor: false,
  }).start();
  assert.equal(indicator.isSpinning, true);
  await cli("invalid-operation", ["--store-creation-id", "invalid operation"]);
  assert.equal(process.exitCode, 1);
  assert.equal(indicator.isSpinning, false);
});

test("Creem source logs actual versions, pages and counts without product payloads", async () => {
  creemMock();
  const log = await cli("source-success", ["--dry-run"]);
  const events = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.event === "source.started");
  assert.equal(started.sdkVersion, "1.4.4");
  assert.equal(started.toolVersion, "0.3.1");
  assert.ok(started.nodeVersion.startsWith("v"));
  assert.ok(
    events.some(
      (event) =>
        event.event === "source.page" && event.page === 1 && event.count === 1
    )
  );
  assert.ok(
    events.some(
      (event) => event.event === "source.completed" && event.count === 1
    )
  );
  assert.equal(log.includes("prod_source"), false);
  assert.equal(log.includes("creem_fake"), false);
});

test("Creem malformed HTTP response logs shape and request ID, never the body", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: { email: "private@example.com" },
        next: "secret-next-url",
      }),
      {
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-shape",
        },
      }
    );
  const log = await cli("source-shape", ["--dry-run"]);
  assert.equal(process.exitCode, 1);
  assert.match(log, /response_shape/);
  assert.match(log, /items:undefined/);
  assert.match(log, /req-shape/);
  assert.equal(log.includes("private@example.com"), false);
  assert.equal(log.includes("secret-next-url"), false);
});

test("Creem authorization failure logs actionable status without SDK response body", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ message: "secret-response-body creem_fake" }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-denied",
        },
      }
    );
  const log = await cli("source-auth", ["--dry-run"]);
  assert.equal(process.exitCode, 1);
  assert.match(log, /authentication_or_permission/);
  assert.match(log, /"status":401/);
  assert.match(log, /req-denied/);
  assert.equal(log.includes("secret-response-body"), false);
  assert.equal(log.includes("creem_fake"), false);
});

test("iterator-shaped SDK result and looping pagination produce diagnostic errors", async () => {
  const file = startAudit(join(dir, "iterator-shape.jsonl"));
  for (const value of [
    { result: { items: [] }, next: () => {} },
    { items: [], pagination: { nextPage: 1 } },
  ]) {
    await assert.rejects(
      sourceStep("creem", "products", async () => validateCreemPage(value, 1)),
      /response_shape/
    );
  }
  const log = readFileSync(file, "utf8");
  assert.match(log, /items:undefined/);
  assert.match(log, /next:function/);
});

test("network and timeout diagnostics omit arbitrary SDK error text", async () => {
  const file = startAudit(join(dir, "source-network.jsonl"));
  for (const name of ["ConnectionError", "RequestTimeoutError"]) {
    await assert.rejects(
      sourceStep("creem", "products", async () => {
        throw Object.assign(new Error("private response payload"), { name });
      }),
      /network|timeout/
    );
  }
  const log = readFileSync(file, "utf8");
  assert.match(log, /"category":"network"/);
  assert.match(log, /"category":"timeout"/);
  assert.equal(log.includes("private response payload"), false);
});

test("Stripe price failure is attributed to prices and retains HTTP request ID", async () => {
  const file = startAudit(join(dir, "stripe-prices.jsonl"));
  globalThis.fetch = async (url) => {
    const path = url instanceof Request ? url.url : String(url);
    return path.includes("/products")
      ? new Response(
          JSON.stringify({ object: "list", data: [], has_more: false }),
          { headers: { "content-type": "application/json" } }
        )
      : new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "permission_denied",
              message: "private payload",
            },
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "request-id": "req-prices",
            },
          }
        );
  };
  await assert.rejects(
    fetchStripeProducts("sk_test_fake"),
    /prices failed.*403/
  );
  const log = readFileSync(file, "utf8");
  assert.match(log, /req-prices/);
  assert.match(log, /"step":"prices"/);
  assert.match(log, /permission_denied/);
  assert.equal(log.includes("private payload"), false);
});

test("Stripe webhook failure has its own diagnostic step", async () => {
  const file = startAudit(join(dir, "stripe-webhooks.jsonl"));
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: "hidden webhook URL" },
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
  await assert.rejects(fetchStripeWebhooks("sk_test_fake"), /webhooks failed/);
  const log = readFileSync(file, "utf8");
  assert.match(log, /"step":"webhooks"/);
  assert.match(log, /authentication_or_permission/);
  assert.equal(log.includes("hidden webhook URL"), false);
});

// Synthetic Dodo responses for unit tests. These are NOT exports of the user's test products.
import { fetchDodoProducts, type DodoProduct } from "../src/dodo/fetcher.js";
import { mapDodoProducts, dodoAmountToDisplay } from "../src/dodo/mapper.js";
function dodoProduct(overrides: Partial<DodoProduct> = {}): DodoProduct {
  return {
    product_id: "pdt_synthetic",
    name: "Synthetic catalog product",
    description: "Test description",
    image: null,
    tax_category: "saas",
    metadata: {},
    price: {
      type: "one_time_price",
      currency: "USD",
      price: 1990,
      tax_inclusive: false,
    },
    ...overrides,
  };
}
const syntheticDodoCatalog = [
  dodoProduct({
    product_id: "pdt_synthetic_starter",
    name: "Synthetic starter",
    price: {
      type: "recurring_price",
      currency: "USD",
      price: 1600,
      tax_inclusive: false,
      payment_frequency_count: 1,
      payment_frequency_interval: "Month",
      subscription_period_count: 1,
      subscription_period_interval: "Year",
    },
  }),
  dodoProduct({
    product_id: "pdt_synthetic_pro",
    name: "Synthetic pro",
    price: {
      type: "recurring_price",
      currency: "USD",
      price: 4200,
      tax_inclusive: false,
      payment_frequency_count: 1,
      payment_frequency_interval: "Month",
      subscription_period_count: 10,
      subscription_period_interval: "Year",
    },
  }),
  dodoProduct({ product_id: "pdt_synthetic_pack", name: "Synthetic pack" }),
];
const dodoJson = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
function mockDodoSource(catalog = syntheticDodoCatalog) {
  const downstream = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith(".dodopayments.com"))
      return downstream(input, init);
    calls.push(url.href);
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname === "/products")
      return dodoJson({
        items:
          url.searchParams.get("page_number") === "0"
            ? catalog.map((p) => ({ product_id: p.product_id, price: 123 }))
            : [],
      });
    return dodoJson(
      catalog.find((p) => url.pathname === `/products/${p.product_id}`)
    );
  };
  return calls;
}
test("Dodo starts at page zero, fetches all 100-item pages and retrieves full details", async () => {
  const pages: number[] = [];
  let details = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://test.dodopayments.com");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer synthetic-token"
    );
    assert.equal(init?.redirect, "error");
    if (url.pathname === "/products") {
      const page = Number(url.searchParams.get("page_number"));
      pages.push(page);
      assert.equal(url.searchParams.get("page_size"), "100");
      assert.equal(url.searchParams.get("archived"), "false");
      return dodoJson({
        items: Array.from(
          { length: page === 0 ? 100 : page === 1 ? 1 : 0 },
          (_, i) => ({
            product_id: `pdt_${page * 100 + i}`,
            price: 1,
            price_detail: { type: "usage_based_price" },
          })
        ),
      });
    }
    details++;
    return dodoJson(
      dodoProduct({ product_id: url.pathname.split("/").pop()! })
    );
  };
  const products = await fetchDodoProducts("synthetic-token", "test");
  assert.equal(products.length, 101);
  assert.equal(details, 101);
  assert.deepEqual(pages, [0, 1, 2]);
  assert.equal(products[0].price.price, 1990);
});
test("Dodo explicit live environment ignores key prefix and handles an empty catalog", async () => {
  globalThis.fetch = async (input) => {
    assert.match(String(input), /^https:\/\/live.dodopayments.com/);
    return dodoJson({ items: [] });
  };
  assert.deepEqual(await fetchDodoProducts("creem_test_synthetic", "live"), []);
  await assert.rejects(
    fetchDodoProducts("synthetic", "invalid" as any),
    /environment/
  );
});
test("Dodo malformed pages/details, repeated pages and authentication failures stop safely", async () => {
  for (const mode of ["shape", "detail", "repeat", "auth", "json"]) {
    let count = 0;
    globalThis.fetch = async (input) => {
      count++;
      if (mode === "auth")
        return new Response("sensitive server response", { status: 401 });
      if (mode === "json") return new Response("invalid");
      if (mode === "shape") return dodoJson({ items: null });
      if (String(input).includes("?"))
        return dodoJson({ items: [{ product_id: "pdt_synthetic" }] });
      return dodoJson(
        mode === "detail" ? { product_id: "wrong", price: 1990 } : dodoProduct()
      );
    };
    await assert.rejects(
      fetchDodoProducts("synthetic-token", "test"),
      mode === "auth"
        ? /authentication_or_permission, HTTP 401/
        : /response_shape/
    );
    assert.ok(count <= 3);
  }
});
test("Dodo maps monthly payment frequency, one-time amounts, tax, metadata and media", () => {
  const mapped = mapDodoProducts(syntheticDodoCatalog);
  assert.equal(mapped.skipped.length, 0);
  assert.deepEqual(
    mapped.products.map((p) => [p.type, p.billingPeriod, p.prices.USD.amount]),
    [
      ["subscription", "monthly", "16.00"],
      ["subscription", "monthly", "42.00"],
      ["onetime", undefined, "19.90"],
    ]
  );
  assert.equal(
    mapped.products[0].metadata._dodoSubscriptionPeriodInterval,
    "Year"
  );
  const p = mapDodoProducts([
    dodoProduct({
      image: "https://example.com/image.png",
      metadata: { custom: "value", _dodoProductId: "wrong" },
    }),
  ]).products[0];
  assert.equal(p.prices.USD.taxCategory, "saas");
  assert.equal(p.description, "Test description");
  assert.deepEqual(p.media, [
    { type: "image", url: "https://example.com/image.png" },
  ]);
  assert.equal(p.metadata.custom, "value");
  assert.equal(p.metadata._dodoProductId, "pdt_synthetic");
});
test("Dodo currency conversion uses zero, two and three minor-unit decimals exactly", () => {
  for (const [value, currency, expected] of [
    [1600, "USD", "16.00"],
    [4200, "USD", "42.00"],
    [1990, "USD", "19.90"],
    [1990, "JPY", "1990"],
    [1990, "KWD", "1.990"],
    [5, "BHD", "0.005"],
    [0, "EUR", "0.00"],
    [123, "MGA", "1.23"],
    [123, "ISK", "123"],
    [12345, "CLF", "1.2345"],
  ] as const) {
    assert.equal(dodoAmountToDisplay(value, currency), expected);
  }
  for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => dodoAmountToDisplay(amount, "USD"));
  assert.throws(() => dodoAmountToDisplay(100, "XXX"));
});
test("Dodo reports unsupported prices, periods, tax and other pricing configurations", () => {
  const base = syntheticDodoCatalog[0];
  const variants = [
    { type: "usage_based_price" },
    { type: "future_price" },
    { payment_frequency_count: 6 },
    { payment_frequency_interval: "Day" },
    { payment_frequency_count: "1" },
    { pay_what_you_want: true },
    { discount: 5 },
    { discount_bps: 1250 },
    { trial_period_days: 7 },
    { purchasing_power_parity: true },
    { currency: "XXX" },
    { price: -1 },
    { tax_inclusive: "true" },
  ];
  for (const price of variants) {
    const result = mapDodoProducts([
      { ...base, price: { ...base.price, ...price } },
    ]);
    assert.equal(result.products.length, 0, JSON.stringify(price));
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].reason);
  }
  for (const tax_category of [
    "live_tutoring",
    "unknown",
    "constructor",
    "__proto__",
  ])
    assert.equal(
      mapDodoProducts([{ ...base, tax_category }]).skipped.length,
      1
    );
  for (const [source, destination] of [
    ["digital_products", "digital_goods"],
    ["e_book", "ebook"],
    ["edtech", "online_course"],
  ]) {
    assert.equal(
      mapDodoProducts([{ ...base, tax_category: source }]).products[0].prices
        .USD.taxCategory,
      destination
    );
  }
  for (const [interval, count, expected] of [
    ["Week", 1, "weekly"],
    ["Month", 3, "quarterly"],
    ["Month", 12, "yearly"],
    ["Year", 1, "yearly"],
  ] as const) {
    assert.equal(
      mapDodoProducts([
        {
          ...base,
          price: {
            ...base.price,
            payment_frequency_interval: interval,
            payment_frequency_count: count,
          },
        },
      ]).products[0].billingPeriod,
      expected
    );
  }
});
test("Dodo preserves inclusive and unknown tax settings and warns about excluded entitlements", () => {
  for (const tax_inclusive of [true, null, undefined]) {
    const result = mapDodoProducts([
      dodoProduct({
        price: { ...dodoProduct().price, tax_inclusive },
        credit_entitlements: [{}],
      }),
    ]);
    assert.equal(
      result.products[0].metadata._dodoTaxInclusive,
      tax_inclusive ?? "unspecified"
    );
    assert.ok(
      result.warnings.some((w) =>
        w.message.includes("--acknowledge-tax-semantics")
      )
    );
    assert.ok(
      result.warnings.some((w) => w.message.includes("separate integration"))
    );
  }
});
async function dodoCli(name: string, args: string[] = []) {
  await createCli().parseAsync(
    [
      "dodo",
      "--api-key",
      "synthetic-dodo-secret",
      "--environment",
      "test",
      "--log-file",
      join(dir, name + ".jsonl"),
      ...args,
    ],
    { from: "user" }
  );
  return readFileSync(join(dir, name + ".jsonl"), "utf8");
}
test("Dodo dry-run needs no destination credentials and performs only source reads", async () => {
  const destinationCalls = mockApi();
  const calls = mockDodoSource();
  const log = await dodoCli("dodo-preview", ["--dry-run"]);
  assert.equal(destinationCalls.length, 0);
  assert.equal(calls.length, 5);
  assert.notEqual(process.exitCode, 1);
  assert.equal(log.includes("synthetic-dodo-secret"), false);
});
test("Dodo rejects unreviewed tax semantics even with --yes", async () => {
  const destinationCalls = mockApi();
  mockDodoSource([
    dodoProduct({ price: { ...dodoProduct().price, tax_inclusive: true } }),
  ]);
  await dodoCli("dodo-tax", ["--yes"]);
  assert.equal(process.exitCode, 1);
  assert.equal(destinationCalls.length, 0);
});
test("Dodo all-unsupported dry-run reports reasons and nonzero exit status", async () => {
  mockDodoSource([dodoProduct({ price: { type: "usage_based_price" } })]);
  const log = await dodoCli("dodo-unsupported", ["--dry-run"]);
  assert.equal(process.exitCode, 1);
  assert.match(log, /Unsupported price type/);
});
test("Dodo real-command mock creates two monthly and one one-time products with verified ID mappings", async () => {
  const created: any[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/create-product")) {
      const id = `PROD_${String(created.length + 1).repeat(22)}`;
      created.push({ ...body, id });
      return response({ product: { id } });
    }
    if (body.query.includes("store(id:")) return response({ store });
    const p = created.find((p) => p.id === body.variables.id);
    return response({
      [body.query.includes("subscriptionProduct(")
        ? "subscriptionProduct"
        : "onetimeProduct"]: {
        ...p,
        storeId,
        status: "active",
        hasProdVersion: false,
        prices: Object.entries(p.prices).map(([currency, priceInfo]) => ({
          currency,
          priceInfo,
        })),
      },
    });
  };
  mockDodoSource();
  const log = await dodoCli("dodo-create", [
    "--merchant-id",
    merchantId,
    "--private-key",
    privateKey,
    "--store-id",
    storeId,
    "--yes",
  ]);
  assert.notEqual(process.exitCode, 1);
  assert.equal(created.length, 3);
  assert.deepEqual(
    created.map((p) => p.billingPeriod),
    ["monthly", "monthly", undefined]
  );
  assert.deepEqual(
    created.map((p) => p.prices.USD.amount),
    ["16.00", "42.00", "19.90"]
  );
  const mappings = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === "dodo.product_mapping");
  assert.equal(mappings.length, 3);
  assert.ok(mappings.every((m) => m.verified));
  assert.deepEqual(
    mappings.map((m) => m.sourceProductId),
    syntheticDodoCatalog.map((p) => p.product_id)
  );
});

test("Dodo non-interactive writes require explicit destination and confirmation", async () => {
  const calls = mockApi();
  mockDodoSource();
  const log = await dodoCli("dodo-no-confirm");
  assert.equal(process.exitCode, 1);
  assert.equal(calls.length, 0);
  assert.match(log, /Non-interactive writes require/);
});
test("Dodo acknowledgement permits reviewed tax semantics and preserves them through creation", async () => {
  const calls = mockApi();
  mockDodoSource([
    dodoProduct({
      name: input.name,
      tax_category: "digital_products",
      price: { ...dodoProduct().price, tax_inclusive: true },
    }),
  ]);
  await dodoCli("dodo-reviewed-tax", [
    "--merchant-id",
    merchantId,
    "--private-key",
    privateKey,
    "--store-id",
    storeId,
    "--yes",
    "--acknowledge-tax-semantics",
  ]);
  assert.notEqual(process.exitCode, 1);
  assert.equal(calls.filter((c) => c.endsWith("/create-product")).length, 1);
});
test("Dodo source errors never log response bodies or bearer credentials", async () => {
  globalThis.fetch = async () =>
    new Response("sensitive response synthetic-dodo-secret", { status: 403 });
  const log = await dodoCli("dodo-auth-error", ["--dry-run"]);
  assert.equal(process.exitCode, 1);
  assert.match(log, /authentication_or_permission/);
  assert.equal(log.includes("synthetic-dodo-secret"), false);
  assert.equal(log.includes("sensitive response"), false);
});

test("Dodo loads destination options from environment and selects source mode via CLI", async () => {
  const values = {
    DODO_PAYMENTS_API_KEY: "synthetic-env-secret",
    WAFFO_MERCHANT_ID: merchantId,
    WAFFO_PRIVATE_KEY_PATH: privateKey,
    WAFFO_STORE_ID: storeId,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  try {
    Object.assign(process.env, values);
    const writes = mockApi();
    const reads = mockDodoSource([
      dodoProduct({ name: input.name, tax_category: "digital_products" }),
    ]);
    await createCli().parseAsync(
      [
        "dodo",
        "--environment",
        "test",
        "--yes",
        "--log-file",
        join(dir, "dodo-env.jsonl"),
      ],
      { from: "user" }
    );
    assert.notEqual(process.exitCode, 1);
    assert.equal(
      writes.filter((url) => url.endsWith("/create-product")).length,
      1
    );
    assert.ok(
      reads.every((url) => url.startsWith("https://test.dodopayments.com/"))
    );
    assert.equal(
      readFileSync(join(dir, "dodo-env.jsonl"), "utf8").includes(
        values.DODO_PAYMENTS_API_KEY
      ),
      false
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Creem accepts shared destination environment variables and its own API key", async () => {
  const values = {
    CREEM_API_KEY: "creem_test_synthetic_env",
    WAFFO_MERCHANT_ID: merchantId,
    WAFFO_PRIVATE_KEY_PATH: privateKey,
    WAFFO_STORE_ID: storeId,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  try {
    Object.assign(process.env, values);
    const calls = creemMock();
    await createCli().parseAsync(
      ["creem", "--dry-run", "--log-file", join(dir, "creem-env.jsonl")],
      { from: "user" }
    );
    assert.notEqual(process.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.equal(
      readFileSync(join(dir, "creem-env.jsonl"), "utf8").includes(
        values.CREEM_API_KEY
      ),
      false
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("actual Dodo test API fixtures map all three requested products", async () => {
  const source = JSON.parse(
    readFileSync("tests/fixtures/dodo-test-products.json", "utf8")
  ) as DodoProduct[];
  mockDodoSource(source);
  const fetched = await fetchDodoProducts("synthetic-token", "test");
  const result = mapDodoProducts(fetched);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    result.products.map((p) => [
      p.metadata._dodoProductId,
      p.type,
      p.billingPeriod,
      p.prices.USD.amount,
    ]),
    [
      ["pdt_0NpPXXZQx3aeqAiN8X5XX", "subscription", "monthly", "16.00"],
      ["pdt_0NpPXbKgvwYvkaNrM0hnY", "subscription", "monthly", "42.00"],
      ["pdt_0NpPXfNz0d0Or0HbC1fWr", "onetime", undefined, "19.90"],
    ]
  );
});

test("Dodo validates response field shapes before mapping or writing", async () => {
  const base = dodoProduct();
  const malformed: unknown[] = [
    null,
    [],
    { ...base, tax_category: null },
    { ...base, name: 12 },
    { ...base, description: {} },
    { ...base, image: [] },
    { ...base, metadata: "wrong" },
    { ...base, metadata: { nested: {} } },
    { ...base, credit_entitlements: {} },
    { ...base, entitlements: null },
    { ...base, addons: [42] },
    { ...base, license_key_enabled: "false" },
    { ...base, pricing_mode: {} },
    { ...base, price: [] },
    { ...base, price: { ...base.price, type: null } },
    { ...base, price: { ...base.price, currency: 123 } },
    { ...base, price: { ...base.price, price: "1990" } },
    { ...base, price: { ...base.price, tax_inclusive: "false" } },
    { ...base, price: { ...base.price, discount_bps: "0" } },
    {
      ...base,
      price: { ...syntheticDodoCatalog[0].price, payment_frequency_count: "1" },
    },
    {
      ...base,
      price: {
        ...syntheticDodoCatalog[0].price,
        payment_frequency_interval: {},
      },
    },
    {
      ...base,
      price: {
        ...syntheticDodoCatalog[0].price,
        subscription_period_count: "1",
      },
    },
  ];
  for (const detail of malformed) {
    globalThis.fetch = async (url) =>
      dodoJson(
        String(url).includes("?")
          ? { items: [{ product_id: base.product_id }] }
          : detail
      );
    await assert.rejects(
      fetchDodoProducts("synthetic-token", "test"),
      /response_shape/
    );
  }
  for (const page of [
    null,
    [],
    { items: [null] },
    { items: [{}] },
    { items: [{ product_id: 123 }] },
  ]) {
    globalThis.fetch = async () => dodoJson(page);
    await assert.rejects(
      fetchDodoProducts("synthetic-token", "test"),
      /response_shape/
    );
  }
});

test("Dodo preserves valid metadata and unknown price variants for explicit skip reporting", async () => {
  const products = [
    dodoProduct({
      metadata: { label: "test", count: 1, enabled: true },
      name: null,
      description: null,
      image: null,
      addons: null,
    }),
    dodoProduct({ product_id: "pdt_future", price: { type: "future_price" } }),
  ];
  mockDodoSource(products);
  const fetched = await fetchDodoProducts("synthetic-token", "test");
  assert.deepEqual(fetched, products);
  const mapped = mapDodoProducts(fetched);
  assert.equal(mapped.products.length, 0);
  assert.deepEqual(
    mapped.skipped.map((item) => item.reason),
    ["Missing product name", "Unsupported price type: future_price"]
  );
});

// ── Lemon Squeezy ──
// Synthetic JSON:API responses shaped after docs.lemonsqueezy.com/api. Not real store data.
import {
  fetchLemonSqueezyCatalog,
  fetchLemonSqueezyStores,
  type LemonSqueezyCatalog,
  type LemonSqueezyProduct,
  type LemonSqueezyVariant,
  type LemonSqueezyDiscount,
} from "../src/lemonsqueezy/fetcher.js";
import {
  mapLemonSqueezyProducts,
  mapLemonSqueezyDiscounts,
  htmlToText,
} from "../src/lemonsqueezy/mapper.js";
import { redact } from "../src/utils/audit.js";

const lsKey =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzeW50aGV0aWMiOnRydWV9.c3ludGhldGljLXNpZ25hdHVyZQ";
const lsStore = { id: "7", name: "Synthetic LS store", currency: "USD" };
function lsPrice(overrides: Record<string, unknown> = {}) {
  return {
    category: "one_time",
    scheme: "standard",
    usage_aggregation: null,
    unit_price: 1990,
    unit_price_decimal: null,
    setup_fee_enabled: null,
    setup_fee: null,
    package_size: 1,
    tiers: null,
    renewal_interval_unit: null,
    renewal_interval_quantity: null,
    trial_interval_unit: null,
    trial_interval_quantity: null,
    min_price: null,
    suggested_price: null,
    tax_code: "eservice",
    ...overrides,
  };
}
const monthly = {
  category: "subscription",
  renewal_interval_unit: "month",
  renewal_interval_quantity: 1,
  setup_fee_enabled: false,
};
interface LsSourceVariant {
  id: string;
  name: string;
  status: string;
  description?: string | null;
  has_license_keys?: boolean;
  has_free_trial?: boolean;
  price: Record<string, unknown> | null;
}
interface LsSourceProduct {
  id: string;
  name: string;
  status?: string;
  description?: string | null;
  variants: LsSourceVariant[];
}
const lsCatalog: LsSourceProduct[] = [
  {
    id: "100",
    name: "Synthetic ebook",
    description: "<p>Read &amp; learn</p><ul><li>One</li><li>Two</li></ul>",
    variants: [
      {
        id: "1000",
        name: "Default",
        status: "pending",
        price: lsPrice({ tax_code: "ebook", unit_price: 900 }),
      },
    ],
  },
  {
    id: "200",
    name: "Synthetic SaaS",
    description: "<p>Hosted app</p>",
    variants: [
      {
        id: "2001",
        name: "Monthly",
        status: "published",
        has_license_keys: true,
        price: lsPrice({ ...monthly, unit_price: 1600, tax_code: "saas" }),
      },
      {
        id: "2002",
        name: "Yearly",
        status: "published",
        price: lsPrice({
          ...monthly,
          renewal_interval_unit: "year",
          unit_price: 16000,
          tax_code: "saas",
        }),
      },
      { id: "2003", name: "Beta", status: "draft", price: lsPrice() },
    ],
  },
];
const lsDiscounts: Array<Record<string, unknown> & { id: string }> = [
  {
    id: "1",
    name: "Launch 20%",
    code: "LAUNCH20",
    amount: 20,
    amount_type: "percent",
    is_limited_to_products: false,
    is_limited_redemptions: true,
    max_redemptions: 50,
    starts_at: null,
    expires_at: "2099-01-01T00:00:00.000000Z",
    duration: "once",
    duration_in_months: 1,
    status: "published",
    variants: [],
  },
  {
    id: "2",
    name: "Monthly SaaS $5 x3",
    code: "SAAS5",
    amount: 500,
    amount_type: "fixed",
    is_limited_to_products: true,
    is_limited_redemptions: false,
    max_redemptions: 0,
    starts_at: null,
    expires_at: null,
    duration: "repeating",
    duration_in_months: 3,
    status: "published",
    variants: ["2001"],
  },
  {
    id: "3",
    name: "Draft",
    code: "DRAFT10",
    amount: 10,
    amount_type: "percent",
    is_limited_to_products: false,
    is_limited_redemptions: false,
    max_redemptions: 0,
    starts_at: null,
    expires_at: null,
    duration: "once",
    duration_in_months: 1,
    status: "draft",
    variants: [],
  },
];
const lsJson = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/vnd.api+json" },
  });
const lsResource = (type: string, id: string, attributes: object) => ({
  type,
  id,
  attributes: { test_mode: true, ...attributes },
});
function mockLemonSqueezy(
  options: {
    catalog?: LsSourceProduct[];
    discounts?: typeof lsDiscounts;
    stores?: (typeof lsStore)[];
    status?: number;
    /** Omit included variant linkage to exercise the related-route fallback. */
    noLinkage?: boolean;
  } = {}
) {
  const catalog = options.catalog ?? lsCatalog;
  const discounts = options.discounts ?? lsDiscounts;
  const stores = options.stores ?? [lsStore];
  const downstream = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.lemonsqueezy.com") return downstream(input, init);
    calls.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${lsKey}`);
    assert.equal(headers.get("Accept"), "application/vnd.api+json");
    assert.equal(init?.redirect, "error");
    if (options.status)
      return lsJson({ errors: [{ detail: lsKey }] }, options.status);
    const q = url.searchParams;
    const page = (data: unknown[]) => lsJson({ data, links: {}, meta: {} });
    switch (url.pathname) {
      case "/v1/stores":
        return page(
          stores.map((s) =>
            lsResource("stores", s.id, { name: s.name, currency: s.currency })
          )
        );
      case "/v1/products":
        assert.equal(q.get("filter[store_id]"), lsStore.id);
        return page(
          catalog.map((p) =>
            lsResource("products", p.id, {
              store_id: Number(lsStore.id),
              name: p.name,
              description: p.description ?? null,
              status: p.status ?? "published",
              thumb_url: null,
              large_thumb_url: `https://cdn.example.test/${p.id}.png`,
            })
          )
        );
      case "/v1/variants": {
        const product = catalog.find(
          (p) => p.id === q.get("filter[product_id]")
        )!;
        return page(
          product.variants.map((v) =>
            lsResource("variants", v.id, {
              product_id: Number(product.id),
              name: v.name,
              description: v.description ?? null,
              status: v.status,
              has_license_keys: v.has_license_keys ?? false,
              has_free_trial: v.has_free_trial ?? false,
            })
          )
        );
      }
      case "/v1/prices": {
        assert.equal(q.get("page[size]"), "1");
        const id = q.get("filter[variant_id]")!;
        const variant = catalog
          .flatMap((p) => p.variants)
          .find((v) => v.id === id)!;
        return page(
          variant.price
            ? [
                lsResource("prices", `p${id}`, {
                  variant_id: Number(id),
                  ...variant.price,
                }),
              ]
            : []
        );
      }
      case "/v1/discounts":
        assert.equal(q.get("include"), "variants");
        return page(
          discounts.map(({ id, variants, ...attributes }) => ({
            ...lsResource("discounts", id, {
              store_id: Number(lsStore.id),
              ...attributes,
            }),
            relationships: {
              variants: {
                links: {
                  related: `https://api.lemonsqueezy.com/v1/discounts/${id}/variants`,
                },
                ...(options.noLinkage
                  ? {}
                  : {
                      data: (variants as string[]).map((v) => ({
                        type: "variants",
                        id: v,
                      })),
                    }),
              },
            },
          }))
        );
    }
    const nested = /^\/v1\/discounts\/(\w+)\/variants$/.exec(url.pathname);
    if (nested) {
      const discount = discounts.find((d) => d.id === nested[1])!;
      return page(
        (discount.variants as string[]).map((id) =>
          lsResource("variants", id, {
            product_id: 0,
            name: "",
            status: "published",
          })
        )
      );
    }
    throw new Error(`Unexpected Lemon Squeezy path ${url.pathname}`);
  };
  return calls;
}
async function lsFetch(options: Parameters<typeof mockLemonSqueezy>[0] = {}) {
  mockLemonSqueezy(options);
  return fetchLemonSqueezyCatalog(lsKey, lsStore, { discounts: true });
}

test("Lemon Squeezy follows links.next across 100-item pages with JSON:API headers", async () => {
  const pages: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.lemonsqueezy.com");
    assert.equal(url.searchParams.get("page[size]"), "100");
    const n = Number(url.searchParams.get("page[number]"));
    pages.push(String(n));
    const data = Array.from({ length: n === 1 ? 100 : 3 }, (_, i) =>
      lsResource("stores", String(n * 1000 + i), { name: "S", currency: "eur" })
    );
    return lsJson({
      data,
      links:
        n === 1
          ? { next: "https://api.lemonsqueezy.com/v1/stores?page[number]=2" }
          : {},
    });
  };
  const stores = await fetchLemonSqueezyStores(lsKey);
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(stores.length, 103);
  assert.equal(stores[0].currency, "EUR");
});

test("Lemon Squeezy reads variants, current prices and linked discount variants per store", async () => {
  const calls = mockLemonSqueezy();
  const catalog = await fetchLemonSqueezyCatalog(lsKey, lsStore, {
    discounts: true,
  });
  assert.equal(catalog.products.length, 2);
  assert.equal(catalog.products[1].variants.length, 3);
  assert.equal(catalog.products[1].variants[0].price?.unit_price, 1600);
  assert.deepEqual(catalog.discounts[1].variantIds, ["2001"]);
  // Included linkage answers it without per-discount requests.
  const nestedCalls = (list: string[]) =>
    list.filter(
      (c) => c.includes("/variants?") && c.startsWith("/v1/discounts")
    );
  assert.equal(nestedCalls(calls).length, 0);
  // Without linkage, only the product-limited discount falls back to the related route.
  const fallback = mockLemonSqueezy({ noLinkage: true });
  const again = await fetchLemonSqueezyCatalog(lsKey, lsStore, {
    discounts: true,
  });
  assert.deepEqual(again.discounts[1].variantIds, ["2001"]);
  assert.equal(nestedCalls(fallback).length, 1);
});

test("Lemon Squeezy rejects malformed discount variant linkage", async () => {
  mockLemonSqueezy();
  const downstream = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await downstream(input, init);
    if (!new URL(String(input)).pathname.endsWith("/v1/discounts")) return res;
    const body = await res.json();
    body.data[1].relationships.variants.data = [
      { type: "products", id: "2001" },
    ];
    return lsJson(body);
  };
  await assert.rejects(
    fetchLemonSqueezyCatalog(lsKey, lsStore, { discounts: true }),
    /response_shape/
  );
});

test("Lemon Squeezy rejects malformed resources and logs only status on auth failure", async () => {
  globalThis.fetch = async () =>
    lsJson({ data: [{ type: "products", id: "1" }] });
  await assert.rejects(
    fetchLemonSqueezyCatalog(lsKey, lsStore, { discounts: false }),
    /response_shape/
  );
  const file = join(dir, "ls-auth.jsonl");
  startAudit(file);
  mockLemonSqueezy({ status: 401 });
  await assert.rejects(
    fetchLemonSqueezyStores(lsKey),
    /authentication_or_permission, HTTP 401/
  );
  endAudit();
  assert.equal(readFileSync(file, "utf8").includes(lsKey), false);
});

test("Lemon Squeezy maps default and published variants, prices, tax, HTML descriptions and media", async () => {
  const catalog = await lsFetch();
  const { products, warnings, skipped } = mapLemonSqueezyProducts(catalog);
  assert.deepEqual(
    products.map((p) => [p.name, p.type, p.billingPeriod, p.prices.USD]),
    [
      [
        "Synthetic ebook",
        "onetime",
        undefined,
        { amount: "9.00", taxCategory: "ebook" },
      ],
      [
        "Synthetic SaaS - Monthly",
        "subscription",
        "monthly",
        { amount: "16.00", taxCategory: "saas" },
      ],
      [
        "Synthetic SaaS - Yearly",
        "subscription",
        "yearly",
        { amount: "160.00", taxCategory: "saas" },
      ],
    ]
  );
  assert.equal(products[0].description, "Read & learn\n\n- One\n- Two");
  assert.deepEqual(products[0].media, [
    { type: "image", url: "https://cdn.example.test/100.png" },
  ]);
  assert.equal(products[1].metadata._lemonSqueezyVariantId, "2001");
  assert.equal(products[1].sourceProductId, "variant:2001");
  assert.deepEqual(
    skipped.map((s) => [s.sourceProductId, s.reason]),
    [["variant:2003", "Draft variant"]]
  );
  assert.match(warnings[0].message, /License keys are not migrated/);
});

test("Lemon Squeezy reports every unsupported pricing configuration instead of guessing", async () => {
  const variant = (
    id: string,
    price: Record<string, unknown> | null,
    extra = {}
  ) => ({
    id,
    name: id,
    status: "published",
    price,
    ...extra,
  });
  const catalog = await lsFetch({
    discounts: [],
    catalog: [
      {
        id: "1",
        name: "Draft product",
        status: "draft",
        variants: [variant("801", lsPrice())],
      },
      {
        id: "2",
        name: "Only drafts",
        variants: [{ ...variant("802", lsPrice()), status: "draft" }],
      },
      {
        id: "3",
        name: "Odd",
        variants: [
          variant("900", lsPrice({ category: "pwyw" })),
          variant("901", lsPrice({ category: "lead_magnet", unit_price: 0 })),
          variant("902", lsPrice({ scheme: "graduated" })),
          variant(
            "903",
            lsPrice({ ...monthly, usage_aggregation: "sum", unit_price: null })
          ),
          variant("904", lsPrice({ ...monthly, setup_fee_enabled: true })),
          variant(
            "905",
            lsPrice({
              ...monthly,
              trial_interval_unit: "day",
              trial_interval_quantity: 14,
            }),
            { has_free_trial: true }
          ),
          variant("906", lsPrice({ ...monthly, renewal_interval_unit: "day" })),
          variant(
            "907",
            lsPrice({
              ...monthly,
              renewal_interval_unit: "week",
              renewal_interval_quantity: 2,
            })
          ),
          variant("908", lsPrice({ tax_code: null })),
          variant("909", lsPrice({ unit_price: 0 })),
          variant("910", null),
          // Trial fields without has_free_trial are leftovers, not an active trial.
          variant(
            "911",
            lsPrice({
              ...monthly,
              renewal_interval_quantity: 3,
              trial_interval_unit: "day",
              trial_interval_quantity: 30,
            })
          ),
        ],
      },
    ],
  });
  const { products, skipped } = mapLemonSqueezyProducts(catalog);
  assert.deepEqual(
    products.map((p) => [p.name, p.billingPeriod]),
    [["Odd - 911", "quarterly"]]
  );
  assert.deepEqual(
    skipped.map((s) => s.reason),
    [
      "Draft product",
      "No published variants",
      "Unsupported pay-what-you-want pricing",
      "Unsupported free lead magnet",
      "Unsupported pricing scheme: graduated",
      "Unsupported usage-based billing",
      "Unsupported subscription setup fee",
      "Unsupported free trial (14 day)",
      "Unsupported billing interval: 1 day",
      "Unsupported billing interval: 2 week",
      "Unsupported tax category: none",
      "Unsupported free price",
      "Variant has no price",
    ]
  );
});

test("Lemon Squeezy amounts use the store currency's ISO minor units", async () => {
  const catalog = await lsFetch({ discounts: [] });
  for (const [currency, amount] of [
    ["JPY", "1990"],
    ["KWD", "1.990"],
    ["EUR", "19.90"],
  ]) {
    const { products } = mapLemonSqueezyProducts({
      ...catalog,
      store: { ...lsStore, currency },
      products: [
        {
          ...catalog.products[0],
          variants: [
            {
              ...catalog.products[0].variants[0],
              price: {
                ...catalog.products[0].variants[0].price!,
                unit_price: 1990,
              },
            },
          ],
        },
      ],
    });
    assert.deepEqual(
      Object.entries(products[0].prices).map(([c, p]) => [c, p.amount]),
      [[currency, amount]]
    );
  }
});

test("Lemon Squeezy discounts map to coupons with product limits, duration and redemption rules", async () => {
  const catalog = await lsFetch();
  const { products } = mapLemonSqueezyProducts(catalog);
  const { coupons, skipped, warnings } = mapLemonSqueezyDiscounts(
    catalog,
    products,
    Date.parse("2026-11-17")
  );
  assert.deepEqual(coupons, [
    {
      sourceDiscountId: "1",
      name: "Launch 20%",
      code: "LAUNCH20",
      discount: { type: "percentage", percentOff: 20 },
      duration: "once",
      durationInPeriods: null,
      maxRedemptions: 50,
      redeemBy: "2099-01-01T00:00:00.000Z",
      // Store-wide discounts are scoped to the migrated products, never the whole target store.
      sourceProductIds: ["variant:1000", "variant:2001", "variant:2002"],
    },
    {
      sourceDiscountId: "2",
      name: "Monthly SaaS $5 x3",
      code: "SAAS5",
      discount: { type: "fixed_amount", amountOff: { USD: "5.00" } },
      duration: "repeating",
      durationInPeriods: 3,
      maxRedemptions: null,
      redeemBy: null,
      sourceProductIds: ["variant:2001"],
    },
  ]);
  assert.deepEqual(
    skipped.map((s) => [s.code, s.reason]),
    [["DRAFT10", "Draft discount"]]
  );
  assert.match(warnings[0].message, /restarts at 50/);
  assert.match(warnings[1].message, /Store-wide discount: limited to the 3 migrated/);
});

test("Lemon Squeezy discounts that cannot be expressed exactly are skipped with reasons", async () => {
  const base = {
    ...lsDiscounts[0],
    is_limited_redemptions: false,
    expires_at: null,
  };
  const catalog = await lsFetch({
    discounts: [
      { ...base, id: "a", code: "OLD", expires_at: "2020-01-01T00:00:00Z" },
      { ...base, id: "b", code: "SOON", starts_at: "2099-01-01T00:00:00Z" },
      { ...base, id: "c", code: "X".repeat(33) },
      {
        ...base,
        id: "d",
        code: "ALLREPEAT",
        duration: "repeating",
        duration_in_months: 2,
      },
      {
        ...base,
        id: "e",
        code: "DRAFTVARIANT",
        is_limited_to_products: true,
        variants: ["2003"],
      },
      {
        ...base,
        id: "f",
        code: "NOVARIANTS",
        is_limited_to_products: true,
        variants: [],
      },
      { ...base, id: "g", code: "BIG", amount: 150 },
      { ...base, id: "h", code: "launch20" },
      { ...base, id: "i", code: "LAUNCH20" },
    ],
  });
  const { products } = mapLemonSqueezyProducts(catalog);
  const { coupons, skipped, warnings } = mapLemonSqueezyDiscounts(
    catalog,
    products,
    Date.parse("2026-11-17")
  );
  assert.deepEqual(
    coupons.map((c) => c.code),
    ["launch20"]
  );
  assert.deepEqual(
    skipped.map((s) => s.reason),
    [
      "Expired discount",
      "Starts in the future; Pancake coupons have no start date",
      "Code must be 3-32 letters, digits or hyphens in Pancake",
      "Repeating for 2 month(s) applies to non-monthly subscriptions; Pancake counts billing periods, not months",
      "Applies to variant(s) that are not migrated: 2003",
      "Limited to products, but no variants are linked",
      "Invalid percentage: 150",
      "Duplicate code",
    ]
  );
  assert.deepEqual(
    warnings.map((w) => w.message.startsWith("Store-wide discount")),
    [true]
  );
});

test("Lemon Squeezy ignores the hidden default variant that whole-product discounts link", async () => {
  // Observed in a real Lemon Squeezy test store: adding variants keeps the original default
  // variant as `pending`, and selecting the whole product in a discount links it as well.
  const catalogWithHidden = lsCatalog.map((p) =>
    p.id === "200"
      ? {
          ...p,
          variants: [
            {
              id: "2000",
              name: "Default",
              status: "pending",
              price: lsPrice(),
            },
            ...p.variants.filter((v) => v.status !== "draft"),
          ],
        }
      : p
  );
  const wholeProduct = {
    ...lsDiscounts[0],
    id: "w",
    code: "SAASALL10",
    is_limited_to_products: true,
    is_limited_redemptions: false,
    expires_at: null,
    variants: ["2000", "2001", "2002"],
  };
  const onlyHidden = {
    ...wholeProduct,
    id: "h",
    code: "HIDDENONLY",
    variants: ["2000"],
  };
  const catalog = await lsFetch({
    catalog: catalogWithHidden,
    discounts: [wholeProduct, onlyHidden],
  });
  const { products, skipped: productSkips } = mapLemonSqueezyProducts(catalog);
  // The hidden default is not a product and not reported as skipped.
  assert.deepEqual(
    products.map((p) => p.sourceProductId),
    ["variant:1000", "variant:2001", "variant:2002"]
  );
  assert.equal(productSkips.length, 0);
  const { coupons, skipped } = mapLemonSqueezyDiscounts(
    catalog,
    products,
    Date.parse("2026-11-17")
  );
  assert.deepEqual(
    coupons.map((c) => [c.code, c.sourceProductIds]),
    [["SAASALL10", ["variant:2001", "variant:2002"]]]
  );
  assert.deepEqual(
    skipped.map((s) => [s.code, s.reason]),
    [["HIDDENONLY", "Limited to products, but no variants are linked"]]
  );
});

test("HTML descriptions become readable plain text", () => {
  assert.equal(
    htmlToText("<h2>Title</h2><p>A&nbsp;&lt;b&gt; &#8212; ok<br>line</p>"),
    "Title\nA <b> — ok\nline"
  );
  assert.equal(htmlToText("<p></p>"), null);
});

test("audit redacts JWT-shaped Lemon Squeezy keys even when not registered", () => {
  assert.equal(redact(`token ${lsKey} end`), "token [REDACTED] end");
});

async function lsCli(name: string, args: string[] = []) {
  await createCli().parseAsync(
    [
      "lemonsqueezy",
      "--api-key",
      lsKey,
      "--log-file",
      join(dir, name + ".jsonl"),
      ...args,
    ],
    { from: "user" }
  );
  return readFileSync(join(dir, name + ".jsonl"), "utf8");
}
const lsWriteArgs = [
  "--merchant-id",
  merchantId,
  "--private-key",
  privateKey,
  "--store-id",
  storeId,
  "--yes",
  "--acknowledge-tax-semantics",
];
/** Pancake mock that stores created products/coupons and answers read-backs from them. */
function mockPancakeWithCoupons(
  options: {
    failProduct?: string;
    couponStatus?: number;
    tamperCoupon?: boolean;
  } = {}
) {
  const created: any[] = [];
  const coupons: any[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("/create-product")) {
      if (body.name === options.failProduct)
        return new Response("{}", { status: 500 });
      const id = `PROD_${String(created.length + 1).repeat(22)}`;
      created.push({ ...body, id });
      return response({ product: { id } });
    }
    if (path.endsWith("/v1/actions/coupon/create-coupon")) {
      if (options.couponStatus)
        return new Response(
          JSON.stringify({ errors: [{ message: "code in use" }] }),
          { status: options.couponStatus }
        );
      const id = `CPN_${String.fromCharCode(65 + coupons.length).repeat(22)}`;
      coupons.push({ ...body, id });
      return response({ coupon: { id, status: "active" } });
    }
    if (body.query.includes("store(id:")) return response({ store });
    if (body.query.includes("coupon(id:")) {
      const c = coupons.find((c) => c.id === body.variables.id);
      return response({
        coupon: {
          id: c.id,
          storeId: c.storeId,
          name: c.name,
          code: options.tamperCoupon ? "OTHER" : c.code.toUpperCase(),
          status: "active",
          discountType: c.discount.type,
          percentOff: c.discount.percentOff ?? null,
          amountOff: c.discount.amountOff
            ? Object.entries(c.discount.amountOff).map(
                ([currency, display]) => ({ currency, display })
              )
            : null,
          duration: c.duration,
          durationInPeriods: c.durationInPeriods ?? null,
          productIds: c.productIds ?? [],
          maxRedemptions: c.maxRedemptions,
          redeemBy: c.redeemBy ? new Date(c.redeemBy).toISOString() : null,
        },
      });
    }
    const p = created.find((p) => p.id === body.variables.id);
    return response({
      [body.query.includes("subscriptionProduct(")
        ? "subscriptionProduct"
        : "onetimeProduct"]: {
        ...p,
        storeId,
        status: "active",
        hasProdVersion: false,
        prices: Object.entries(p.prices).map(([currency, priceInfo]) => ({
          currency,
          priceInfo,
        })),
      },
    });
  };
  return { created, coupons };
}
const events = (log: string, event: string) =>
  log
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === event);

test("Lemon Squeezy dry-run performs only source reads and reports skipped items", async () => {
  const destination = mockApi();
  mockLemonSqueezy();
  const log = await lsCli("ls-preview", ["--dry-run"]);
  assert.equal(destination.length, 0);
  // The draft variant and draft discount are partial-migration signals.
  assert.equal(process.exitCode, 1);
  assert.equal(events(log, "product.skipped").length, 1);
  assert.equal(events(log, "coupon.skipped").length, 1);
  assert.equal(log.includes(lsKey), false);
});

test("Lemon Squeezy writes require tax acknowledgement and explicit destination", async () => {
  const destination = mockApi();
  mockLemonSqueezy();
  let log = await lsCli(
    "ls-no-tax",
    lsWriteArgs.filter((a) => a !== "--acknowledge-tax-semantics")
  );
  assert.match(log, /does not expose whether prices include tax/);
  mockLemonSqueezy();
  log = await lsCli("ls-no-target", ["--acknowledge-tax-semantics"]);
  assert.match(log, /Non-interactive writes require/);
  assert.equal(destination.length, 0);
});

test("Lemon Squeezy needs --ls-store-id when the key reaches several stores", async () => {
  mockLemonSqueezy({ stores: [lsStore, { ...lsStore, id: "8" }] });
  const log = await lsCli("ls-stores", ["--dry-run"]);
  assert.equal(process.exitCode, 1);
  assert.match(log, /pass --ls-store-id/);
  mockLemonSqueezy({ stores: [lsStore, { ...lsStore, id: "8" }] });
  await lsCli("ls-stores-ok", [
    "--dry-run",
    "--ls-store-id",
    "7",
    "--skip-discounts",
  ]);
});

test("Lemon Squeezy real-command mock creates products then product-scoped coupons and verifies both", async () => {
  const { created, coupons } = mockPancakeWithCoupons();
  // Without the draft variant and draft discount nothing is skipped, so the run must exit 0.
  const catalog = lsCatalog.map((p) => ({
    ...p,
    variants: p.variants.filter((v) => v.status !== "draft"),
  }));
  mockLemonSqueezy({
    catalog,
    discounts: lsDiscounts.filter((d) => d.status === "published"),
  });
  const log = await lsCli("ls-create", lsWriteArgs);
  assert.notEqual(process.exitCode, 1);
  assert.deepEqual(
    created.map((p) => p.name),
    ["Synthetic ebook", "Synthetic SaaS - Monthly", "Synthetic SaaS - Yearly"]
  );
  assert.equal(coupons.length, 2);
  assert.deepEqual(
    [...coupons[0].productIds].sort(),
    created.map((p: any) => p.id).sort(),
    "store-wide coupons are limited to the migrated products"
  );
  assert.deepEqual(coupons[1].productIds, [created[1].id]);
  assert.equal(coupons[1].durationInPeriods, 3);
  assert.ok(
    events(log, "lemonsqueezy.product_mapping").every((e) => e.verified)
  );
  const couponMappings = events(log, "lemonsqueezy.coupon_mapping");
  assert.deepEqual(
    couponMappings.map((e) => [e.sourceDiscountId, e.couponId, e.verified]),
    [
      ["1", coupons[0].id, true],
      ["2", coupons[1].id, true],
    ]
  );
});

test("Lemon Squeezy coupon is not created when its restricted product failed", async () => {
  const { coupons } = mockPancakeWithCoupons({
    failProduct: "Synthetic SaaS - Monthly",
  });
  mockLemonSqueezy({ discounts: [lsDiscounts[1]] });
  const log = await lsCli("ls-coupon-guard", lsWriteArgs);
  assert.equal(process.exitCode, 1);
  assert.equal(coupons.length, 0);
  assert.match(
    events(log, "coupon.failed")[0].error,
    /variant:2001 were not created and verified/
  );
});

test("Lemon Squeezy coupon conflicts and read-back mismatches fail without false success", async () => {
  mockPancakeWithCoupons({ couponStatus: 409 });
  mockLemonSqueezy({ discounts: [lsDiscounts[0]] });
  let log = await lsCli("ls-coupon-409", lsWriteArgs);
  assert.equal(process.exitCode, 1);
  assert.match(
    events(log, "coupon.failed")[0].error,
    /already used by an active coupon/
  );
  process.exitCode = 0;
  mockPancakeWithCoupons({ tamperCoupon: true });
  mockLemonSqueezy({ discounts: [lsDiscounts[0]] });
  log = await lsCli("ls-coupon-mismatch", lsWriteArgs);
  assert.equal(process.exitCode, 1);
  const unverified = events(log, "coupon.unverified");
  assert.equal(unverified.length, 1);
  assert.match(unverified[0].couponId, /^CPN_/);
});

test("tax acknowledgement: flag passes, scripts fail closed, terminals ask", async () => {
  const error = "Review taxes, then pass --acknowledge-tax-semantics. No writes made.";
  const asked: string[] = [];
  const ask = (answer: boolean) => async (message: string) => {
    asked.push(message);
    return answer;
  };
  await ensureTaxAcknowledged("lemonsqueezy", true, error, { interactive: true, ask: ask(false) });
  assert.equal(asked.length, 0, "the flag never prompts");
  await assert.rejects(
    ensureTaxAcknowledged("lemonsqueezy", undefined, error, { interactive: false, ask: ask(true) }),
    { message: error }
  );
  assert.equal(asked.length, 0, "non-interactive runs never prompt");
  await ensureTaxAcknowledged("dodo", undefined, error, { interactive: true, ask: ask(true) });
  assert.equal(asked.length, 1);
  assert.equal(
    await ensureTaxAcknowledged("dodo", undefined, error, { interactive: true, ask: ask(false) }),
    false,
    "declining cancels like the final confirmation does"
  );
});

test("Lemon Squeezy coupons: drafts-only hidden default, safe name truncation, nothing to scope to", async () => {
  const catalog = await lsFetch({
    catalog: [
      ...lsCatalog,
      {
        id: "300",
        name: "Unreleased",
        description: "",
        variants: [
          { id: "3000", name: "Default", status: "pending", price: lsPrice() },
          { id: "3001", name: "Pro", status: "draft", price: lsPrice() },
        ],
      },
    ],
    discounts: [
      {
        ...lsDiscounts[0],
        id: "e",
        code: "EBOOKPLUS",
        name: "x".repeat(63) + "\u{1F389} sale",
        is_limited_to_products: true,
        is_limited_redemptions: false,
        expires_at: null,
        // Whole-product selection of the ebook and of a product whose other variant is a draft.
        variants: ["1000", "3000"],
      },
    ],
  });
  const { products } = mapLemonSqueezyProducts(catalog);
  const { coupons, skipped } = mapLemonSqueezyDiscounts(
    catalog,
    products,
    Date.parse("2026-11-17")
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(coupons[0].sourceProductIds, ["variant:1000"]);
  assert.equal(coupons[0].name, "x".repeat(63), "never splits the emoji's surrogate pair");

  const storeWide = {
    ...catalog,
    discounts: [{ ...catalog.discounts[0], is_limited_to_products: false, variantIds: [] }],
  };
  const none = mapLemonSqueezyDiscounts(storeWide, [], Date.parse("2026-11-17"));
  assert.deepEqual(
    none.skipped.map((s) => s.reason),
    ["Applies to the whole store, but no products are migrated"]
  );
});

/** Stripe webhook endpoints + Pancake store mock that records webhook updates. */
function stripeWebhookMock(urls: string[]) {
  const updates: any[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("api.stripe.com"))
      return new Response(
        JSON.stringify({
          object: "list",
          has_more: false,
          url: "/v1/webhook_endpoints",
          data: urls.map((u, i) => ({
            id: `we_${i}`,
            object: "webhook_endpoint",
            url: u,
            enabled_events: ["checkout.session.completed"],
            status: "enabled",
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("/update-store")) {
      updates.push(body.webhookSettings);
      return response({ store });
    }
    return response({ store, stores: [store] });
  };
  return updates;
}
const stripeWebhookArgs = (name: string, extra: string[] = []) => [
  "stripe",
  "--stripe-key",
  "sk_test_fake",
  "--merchant-id",
  merchantId,
  "--private-key",
  privateKey,
  "--store-id",
  storeId,
  "--tax-category",
  "saas",
  "--skip-products",
  "--skip-branding",
  "--yes",
  "--log-file",
  join(dir, name + ".jsonl"),
  ...extra,
];

test("Stripe: several webhook endpoints are not silently collapsed into one", async () => {
  const updates = stripeWebhookMock(["https://a.example/hook", "https://b.example/hook"]);
  await createCli().parseAsync(stripeWebhookArgs("stripe-multi-wh"), { from: "user" });
  assert.equal(updates.length, 0, "no endpoint may overwrite another without a choice");
  assert.equal(process.exitCode, 1, "skipped endpoints make the run incomplete");
});

test("Stripe: --webhook-url migrates exactly the chosen endpoint", async () => {
  const updates = stripeWebhookMock(["https://a.example/hook", "https://b.example/hook"]);
  await createCli().parseAsync(
    stripeWebhookArgs("stripe-pick-wh", ["--webhook-url", "https://a.example/hook"]),
    { from: "user" }
  );
  assert.deepEqual(
    updates.map((u) => u.testWebhookUrl),
    ["https://a.example/hook"]
  );
  assert.notEqual(process.exitCode, 1);
});

test("Creem: unmapped tax categories and billing periods are skipped, never substituted", async () => {
  const { mapCreemProducts } = await import("../src/creem/mapper.js");
  const base = {
    description: "",
    price: 1000,
    currency: "usd",
    imageUrl: null,
  };
  const result = mapCreemProducts([
    { ...base, id: "p1", name: "Course", billingType: "onetime", billingPeriod: "once", taxCategory: "courses" },
    { ...base, id: "p2", name: "Weekly", billingType: "recurring", billingPeriod: "every-week", taxCategory: "saas" },
    { ...base, id: "p3", name: "Ok", billingType: "onetime", billingPeriod: "once", taxCategory: "ebooks" },
  ] as any);
  assert.deepEqual(
    result.products.map((p) => p.sourceProductId),
    ["p3"]
  );
  assert.deepEqual(
    result.skipped.map((s) => s.reason),
    ["Unmapped tax category: courses", "Unsupported billing period: every-week"]
  );
});
