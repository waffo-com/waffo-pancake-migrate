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
  assert.equal(started.toolVersion, "0.2.0");
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
