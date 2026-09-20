import { Creem } from "creem";
import type { ProductEntity } from "creem/models/components/productentity.js";

export interface CreemProduct {
  id: string;
  name: string;
  description: string;
  imageUrl: string | undefined;
  price: number; // cents
  currency: string;
  billingType: "recurring" | "onetime";
  billingPeriod: string;
  status: string;
  taxCategory: string;
  defaultSuccessUrl: string | null | undefined;
}

export async function fetchCreemProducts(
  apiKey: string,
  isTest: boolean
): Promise<CreemProduct[]> {
  const creem = new Creem({
    apiKey,
    serverIdx: isTest ? 1 : 0,
  });

  const products: CreemProduct[] = [];
  let page = 1;
  const pageSize = 50;

  while (true) {
    const result = await creem.products.search(page, pageSize);
    for (const p of result.items) {
      if (p.status !== "active") continue;
      products.push({
        id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        price: p.price,
        currency: p.currency,
        billingType: p.billingType,
        billingPeriod: p.billingPeriod,
        status: p.status,
        taxCategory: p.taxCategory,
        defaultSuccessUrl: p.defaultSuccessUrl,
      });
    }

    if (!result.pagination.nextPage) break;
    page = result.pagination.nextPage;
  }

  return products;
}
