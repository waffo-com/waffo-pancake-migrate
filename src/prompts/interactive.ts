import { input, password, select } from "@inquirer/prompts";
import ora from "ora";
import { listPancakeStores } from "../pancake/creator.js";
import { registerSecret } from "../utils/audit.js";
import type {
  MigrationSource,
  StripeCommandOptions,
  CreemCommandOptions,
  PancakeTaxCategory,
} from "../utils/types.js";

const TAX_CATEGORY_OPTIONS: PancakeTaxCategory[] = [
  "saas",
  "digital_goods",
  "software",
  "ebook",
  "online_course",
  "consulting",
  "professional_service",
];

// ── Source selection ──

export async function selectSource(): Promise<MigrationSource> {
  return (await select({
    message: "Where are you migrating from?",
    choices: [
      { name: "Stripe", value: "stripe" as const },
      { name: "Creem", value: "creem" as const },
    ],
  })) as MigrationSource;
}

// ── Pancake credentials + store selection (shared) ──

async function resolvePancakeCredentials(partial: {
  merchantId?: string;
  privateKey?: string;
}): Promise<{ merchantId: string; privateKey: string }> {
  const merchantId =
    partial.merchantId ??
    (await input({
      message: "Pancake Merchant ID (MER_...):",
      validate: (val) => (val.startsWith("MER_") ? true : "Must start with MER_"),
    }));

  let privateKey =
    partial.privateKey ??
    (await password({
      message: "Pancake Private Key (file path or paste content):",
      validate: (val) => (val.length > 0 ? true : "Required"),
    }));

  // Read file if it looks like a path
  const looksLikeFilePath =
    privateKey.length < 256 &&
    !privateKey.includes("-----") &&
    !privateKey.includes("=");
  if (looksLikeFilePath) {
    try {
      const fs = await import("fs/promises");
      privateKey = await fs.readFile(privateKey, "utf-8");
    } catch {
      // Not a file path, use as-is
    }
  }

  registerSecret(privateKey);
  return { merchantId, privateKey };
}

async function resolveStoreId(
  merchantId: string,
  privateKey: string,
  partialStoreId?: string
): Promise<string> {
  if (partialStoreId) return partialStoreId;

  const storesSpinner = ora("Fetching stores from Pancake...").start();
  try {
    const stores = await listPancakeStores(merchantId, privateKey);
    storesSpinner.succeed(`Found ${stores.length} stores`);

    const NEW_STORE_VALUE = "__new__";
    const choices = [
      { name: "+ Create a new store", value: NEW_STORE_VALUE },
      ...stores.map((s) => ({
        name: `${s.name} (${s.id}) [${s.status}]`,
        value: s.id,
      })),
    ];

    const selected = await select({
      message: "Target store:",
      choices,
      default: stores.length > 0 ? stores[0].id : NEW_STORE_VALUE,
    });

    if (selected === NEW_STORE_VALUE) return "new";

    return selected;
  } catch (err) {
    storesSpinner.fail("Failed to connect to Pancake");
    throw err;
  }
}

// ── Stripe interactive prompts ──

interface ResolvedStripeConfig {
  stripeKey: string;
  merchantId: string;
  privateKey: string;
  storeId: string;
  storeName?: string;
  taxCategory: PancakeTaxCategory;
  dryRun: boolean;
  yes: boolean;
}

export async function runInteractivePrompts(
  partial: StripeCommandOptions
): Promise<ResolvedStripeConfig> {
  // 1. Stripe Key
  const stripeKey =
    partial.stripeKey ??
    (await password({
      message: "Stripe Secret Key:",
      validate: (val) => {
        if (!val.startsWith("sk_test_") && !val.startsWith("sk_live_")) {
          return "Must start with sk_test_ or sk_live_";
        }
        return true;
      },
    }));

  registerSecret(stripeKey);

  // 2. Pancake credentials
  const { merchantId, privateKey } = await resolvePancakeCredentials(partial);

  // 3. Store selection (create or existing)
  const storeId = await resolveStoreId(merchantId, privateKey, partial.storeId);
  const storeName = storeId === "new" ? partial.storeName ?? await input({
    message: "New store name:",
    validate: value => value.trim().length > 0 && value.trim().length <= 48 ? true : "1-48 characters required",
  }) : undefined;

  // 4. Tax category
  const taxCategory =
    partial.taxCategory ??
    ((await select({
      message: "Default tax category for imported products:",
      choices: TAX_CATEGORY_OPTIONS.map((c) => ({ name: c, value: c })),
      default: "saas",
    })) as PancakeTaxCategory);

  return {
    stripeKey,
    merchantId,
    privateKey,
    storeId,
    storeName,
    taxCategory,
    dryRun: partial.dryRun ?? false,
    yes: partial.yes ?? false,
  };
}

// ── Creem interactive prompts ──

interface ResolvedCreemConfig {
  apiKey: string;
  merchantId: string;
  privateKey: string;
  storeId: string;
  storeName?: string;
  dryRun: boolean;
  yes: boolean;
}

export async function runCreemInteractivePrompts(
  partial: CreemCommandOptions
): Promise<ResolvedCreemConfig> {
  // 1. Creem API Key
  const apiKey =
    partial.apiKey ??
    (await password({
      message: "Creem API Key:",
      validate: (val) => {
        if (!val.startsWith("creem_")) return "Must start with creem_";
        return true;
      },
    }));

  registerSecret(apiKey);

  // 2. Pancake credentials
  const { merchantId, privateKey } = await resolvePancakeCredentials(partial);

  // 3. Store selection (create or existing)
  const storeId = await resolveStoreId(merchantId, privateKey, partial.storeId);
  const storeName = storeId === "new" ? partial.storeName ?? await input({
    message: "New store name:",
    validate: value => value.trim().length > 0 && value.trim().length <= 48 ? true : "1-48 characters required",
  }) : undefined;

  return {
    apiKey,
    merchantId,
    privateKey,
    storeId,
    storeName,
    dryRun: partial.dryRun ?? false,
    yes: partial.yes ?? false,
  };
}
