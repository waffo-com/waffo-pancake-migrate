# @waffo/pancake-migrate

Migrate products and settings from **Stripe**, **Creem**, or **Dodo Payments** to [Waffo Pancake](https://waffo.ai).

## Quick Start

```bash
npx @waffo/pancake-migrate
```

Interactive mode guides you through:

1. **Choose source** — Stripe, Creem, or Dodo Payments
2. **Choose target store** — existing store or create a new one
3. **Preview** — see what will be migrated before confirming
4. **Migrate** — products, prices, images, webhooks, and branding

## Usage

### Interactive Mode

```bash
npx @waffo/pancake-migrate
```

### Stripe

```bash
# Full migration (products + webhooks + branding)
npx @waffo/pancake-migrate stripe \
  --stripe-key sk_test_xxx \
  --merchant-id MER_xxx \
  --private-key ./private.pem \
  --store-id STO_xxx \
  --tax-category saas

# Dry run (preview only)
npx @waffo/pancake-migrate stripe \
  --stripe-key sk_test_xxx \
  --merchant-id MER_xxx \
  --private-key ./private.pem \
  --store-id STO_xxx \
  --tax-category saas \
  --dry-run

# Create a new store during migration
npx @waffo/pancake-migrate stripe \
  --stripe-key sk_test_xxx \
  --merchant-id MER_xxx \
  --private-key ./private.pem \
  --store-id new \
  --tax-category saas

# Skip specific steps
npx @waffo/pancake-migrate stripe ... --skip-webhooks --skip-branding
```

### Creem

For local tests, fill `CREEM_API_KEY` with a Creem test-mode key in `.env.test`.
Dodo and Creem share `WAFFO_MERCHANT_ID`, `WAFFO_PRIVATE_KEY_PATH` and
`WAFFO_STORE_ID`. The existing Creem workflow asks for Waffo credentials even
for preview; missing values are prompted interactively. Environment selection
continues to use the existing Creem key-prefix logic, so use a `creem_test_` key
for test runs. CLI flags override these environment values.

```bash
npm run creem:preview
npm run creem:migrate
```

These shortcuts use native `--env-file` and require Node.js 20.6+.


```bash
npx @waffo/pancake-migrate creem \
  --api-key creem_test_xxx \
  --merchant-id MER_xxx \
  --private-key ./private.pem \
  --store-id STO_xxx

# Dry run
npx @waffo/pancake-migrate creem \
  --api-key creem_test_xxx \
  --merchant-id MER_xxx \
  --private-key ./private.pem \
  --store-id STO_xxx \
  --dry-run
```

### Dodo Payments

For local test runs, copy `.env.test.example` to `.env.test` if it does not already exist,
then fill in `DODO_PAYMENTS_API_KEY`. Add `WAFFO_MERCHANT_ID`,
`WAFFO_PRIVATE_KEY_PATH` (an absolute path, not key contents), and `WAFFO_STORE_ID`
when ready to write. `.env.test` and its local variants are ignored by Git; only the
empty `.env.test.example` template belongs in the repository.

```bash
npm run dodo:preview  # Build and preview; no Waffo writes
npm run dodo:migrate  # Build, preview and ask for confirmation before writing
```

These local shortcuts require **Node.js 20.6+** for native `--env-file` loading.
Both explicitly select Dodo **test** mode (`https://test.dodopayments.com`).
`DODO_PAYMENTS_BASE_URL` is not used; the endpoint comes from `--environment test|live`
or the interactive environment selection. No environment-selection variable is needed in `.env.test`. They do not supply `--yes` or acknowledge
tax semantics automatically. If needed after review, use
`npm run dodo:migrate -- --acknowledge-tax-semantics`.
The ordinary CLI still supports Node.js 18+ with exported environment variables
or interactive prompts; it does not automatically load `.env.test`. Explicit CLI
options take precedence over environment variables. `npm test` remains an offline
mock test suite and never loads this credential file.


Build this checkout with `npm run build`, then preview using a Dodo Products Read
key supplied privately through `DODO_PAYMENTS_API_KEY` (or a hidden interactive
prompt). Do not put real keys in examples, shell history, logs or fixtures.

```bash
# Source-only preview; DODO_PAYMENTS_API_KEY is already set securely.
node dist/index.js dodo --environment test --dry-run

# Create test-version products after reviewing the preview and confirming the target.
node dist/index.js dodo --environment test \
  --merchant-id MER_xxx \
  --private-key /absolute/path/to/private.pem \
  --store-id STO_xxx
```

`--environment test|live` explicitly selects the Dodo API; key prefixes are never
used to infer it. Interactive mode asks for the environment. Non-interactive
writes require all destination credentials and `--yes`. Destination products are
created through the existing Waffo creator and verified by read-back; neither
Dodo mode publishes Waffo products to production. The final output and audit log
include each Dodo → Waffo product ID mapping, including IDs returned by an
unverified creation. Check those IDs before retrying.

Only product catalog and pricing are in scope. The reader requests unarchived
products with zero-based pages of 100, continues to an empty page, and fetches
full details for every ID (list prices are summaries).

| Dodo field | Waffo behavior |
|---|---|
| name, description, image | name, description, image media |
| `one_time_price` | One-time product |
| `recurring_price` | Subscription; frequency comes from `payment_frequency_*` |
| Frequency | 1 week → weekly; 1 month → monthly; 3 months → quarterly; 12 months or 1 year → yearly |
| Integer price | ISO minor-unit conversion, e.g. USD 1600 → 16.00, JPY 1600 → 1600, KWD 1600 → 1.600 |
| Tax categories | saas → saas; digital_products → digital_goods; e_book → ebook; edtech → online_course |
| Source metadata | Copied; reserved `_dodo*` fields record the source ID and tax/duration settings |
| `subscription_period_*` | Preserved in metadata and warned about; does not set billing frequency or Waffo subscription end dates |
| `tax_inclusive` | Preserved as `_dodoTaxInclusive`; true/unspecified settings require review and `--acknowledge-tax-semantics` before writes |

The tax acknowledgement confirms that you reviewed the destination's tax behavior;
it does **not** configure tax-inclusive pricing. The current Waffo price input has
no equivalent tax-inclusive field. `--yes` does not bypass this review.

Usage-based prices, other billing periods, unknown/unmapped tax categories
(including live_tutoring), discounts, trials, pay-what-you-want, purchasing power
parity, localized pricing and addons are explicitly skipped with reasons.
Skipped products give exit code 1, including in dry-run, so a partial catalog is
never reported as fully migrated. Supported products can still be migrated.

Attached entitlements, licenses and digital delivery are reported but not migrated.
Credit counts in descriptions remain text; website credit fulfillment needs a
separate application integration. Customers, existing subscriptions, payment
methods, webhooks and branding are outside the Dodo migration scope.

Dodo also accepts the shared `--store-id new --store-name "My store"`,
`--store-creation-id`, and `--log-file` options. No destination writes occur during
preview or before confirmation.

#### Dodo test acceptance

Automated tests include synthetic edge cases and allowlisted real Dodo test product
responses in `tests/fixtures/dodo-test-products.json`, fetched on 2026-10-10.
The real API uses `Day`, `Week`, `Month`, `Year` interval values. Source preview
and destination creation/read-back have been verified for all three products.
A representative Dodo one-time checkout and Creem monthly subscription checkout
also passed manual sandbox payment and merchant-dashboard verification on 2026-10-10.
These manual checks are separate from `npm test`; future renewals and application
credit fulfillment were not tested. Acceptance steps:

1. Fetch actual Dodo responses and create sanitized fixtures without keys, headers
   or unrelated business data; do not present the configuration below as an API export.
2. Preview the source. For the supplied test account, expect exactly these products:

| Product ID | Expected USD | Expected type |
|---|---|---|
| `pdt_0NpPXXZQx3aeqAiN8X5XX` | 16.00 | Monthly subscription |
| `pdt_0NpPXbKgvwYvkaNrM0hnY` | 42.00 | Monthly subscription |
| `pdt_0NpPXfNz0d0Or0HbC1fWr` | 19.90 | One-time |

3. Review actual tax and duration settings, confirm the intended destination,
   and run the migration. Verify two monthly products and one one-time product
   in the Waffo test workflow and retain their ID mapping. The reader migrates all
   unarchived products; unexpected additional products must be reviewed before writing.

References: [Dodo authentication/environments](https://docs.dodopayments.com/api-reference/introduction),
[list](https://docs.dodopayments.com/api-reference/products/get-products),
[detail](https://docs.dodopayments.com/api-reference/products/get-products-1),
[official TypeScript schema](https://github.com/dodopayments/dodopayments-typescript/blob/main/src/resources/products/products.ts).

## What Gets Migrated

### From Stripe

| Data | Status |
|------|--------|
| Products + Prices | Migrated (multi-currency, images, descriptions) |
| Billing periods | Mapped (week→weekly, month→monthly, month/3→quarterly, year→yearly) |
| Webhook endpoints | Migrated (URL + event type mapping) |
| Store branding | Migrated (support email + website) |
| Environment | Auto-detected (sk_test\_→test, sk_live\_→production) |

### From Creem

| Data | Status |
|------|--------|
| Products + Prices | Migrated (single-currency, images, descriptions) |
| Billing periods | Mapped (every-month→monthly, every-three-months→quarterly, every-year→yearly) |
| Tax categories | Mapped (saas→saas, digital-goods-service→digital_goods, ebooks→ebook) |

### Not Migrated

- Active subscriptions (must be created through checkout)
- Customer data (auto-created on first purchase)
- Payment methods (PCI compliance)
- Coupons/discounts (not supported by Pancake)
- Checkout theme colors (Stripe doesn't expose via API)

## Options

### Stripe

| Flag | Description |
|------|-------------|
| `--stripe-key <key>` | Stripe Secret Key (sk_test\_... or sk_live\_...) |
| `--merchant-id <id>` | Pancake Merchant ID (MER\_...) |
| `--private-key <path>` | Path to Pancake API private key file, or raw key content |
| `--store-id <id>` | Target Store ID (STO\_...) or `new` to create |
| `--tax-category <cat>` | Default tax category (saas, digital_goods, software, ebook, online_course, consulting, professional_service) |
| `--dry-run` | Preview without creating |
| `--yes` | Skip confirmation |
| `--skip-products` | Skip product migration |
| `--skip-webhooks` | Skip webhook migration |
| `--skip-branding` | Skip branding migration |

### Creem

| Flag | Description |
|------|-------------|
| `--api-key <key>` | Creem API Key (creem_test\_... or creem\_...) |
| `--merchant-id <id>` | Pancake Merchant ID (MER\_...) |
| `--private-key <path>` | Path to Pancake API private key file, or raw key content |
| `--store-id <id>` | Target Store ID (STO\_...) or `new` to create |
| `--dry-run` | Preview without creating |
| `--yes` | Skip confirmation |

## Requirements

- Node.js 18+
- Waffo Pancake API Key ([sign up](https://waffo.ai))
- Source platform API key (Stripe, Creem, or Dodo Payments)

## License

MIT

### Migration logs and verification

Every CLI run writes a private JSONL audit log under `.pancake-migrate/logs/` and prints
its absolute path. Use `--log-file <path>` to choose a **new** file (existing files
are never overwritten). Logs contain timestamps, target merchant/store/product IDs,
Pancake API paths, HTTP status/request IDs when provided, and verification results.
Source reads also record the tool/Node/installed SDK versions, the operation
(products, prices, branding or webhooks), duration and item counts. Creem reads
include page numbers and a value-free response shape to diagnose SDK/schema
mismatches such as `result.items is not iterable`. Source failures are classified
as authentication/permission, HTTP, rate limit, timeout, network or response-shape
errors where the SDK provides enough evidence; otherwise they are marked
`sdk_or_network`. Raw SDK error messages and response
bodies are omitted because they may contain private data.
Request bodies, authentication headers, API keys, private keys and signatures are
not recorded. Treat logs as private business data even though credentials are redacted.

Stores are queried after creation and before any product writes. Products are queried
after creation to check their store, name, price/currency/tax category, active status,
billing period and production-version availability. Reads retry up to three times;
create requests are not retried by the verifier. `VERIFIED` means read-back passed;
`UNVERIFIED` preserves the returned product ID for investigation. A failure produces
an incomplete summary and exit code 1, rather than a successful migration message.
These API checks do not guarantee the dashboard UI or checkout works.

Products are created as test versions; this tool does not publish them to production.
The target dashboard URL and version availability are shown in the output.
For non-interactive store creation, pass `--store-id new --store-name "My store"`.
Store creation happens only after confirmation; `--dry-run` never creates a store.

Run `npm test`, `npm run typecheck` and `npm run build` for local verification.

GraphQL reads omit `X-Idempotency-Key` so verification and store selection read
current state instead of a previous successful response. Write requests retain
idempotency protection. If store creation returns an ID that cannot be verified,
the tool stops; it does not automatically issue another creation request.

If you have checked the old store ID and intentionally want a **new** store with
the same name, pass `--store-id new --store-name "My store"
--store-creation-id my-store-attempt-2`. Use the **same** creation ID and store name
when retrying that operation (including after a timeout). Change the ID only when
you intend another creation; different IDs can create duplicate stores. IDs accept
1–128 letters, digits, underscores or hyphens. This option affects only store
creation, not product retry keys. Server idempotency retention limits still apply;
this is not a permanent deduplication guarantee.
