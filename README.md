# @waffo/pancake-migrate

Migrate products and settings from **Stripe** or **Creem** to [Waffo Pancake](https://waffo.ai).

## Quick Start

```bash
npx @waffo/pancake-migrate
```

Interactive mode guides you through:

1. **Choose source** — Stripe or Creem
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
- Source platform API key (Stripe Secret Key or Creem API Key)

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
