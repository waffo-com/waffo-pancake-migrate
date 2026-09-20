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
