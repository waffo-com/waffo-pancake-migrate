import { Creem } from "creem";
import { HTTPClient } from "creem/lib/http.js";
import { audit, registerSecret } from "../utils/audit.js";
import {
  sourceStep,
  validateCreemPage,
  recordCreemShape,
} from "../utils/source-diagnostics.js";

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
  registerSecret(apiKey);
  return sourceStep("creem", "products", async () => {
    let page = 1;
    const creem = new Creem({
      httpClient: new HTTPClient({
        fetcher: async (url, init) => {
          audit("source.request", { source: "creem", step: "products", page });
          const started = Date.now();
          const response = await globalThis.fetch(url, init);
          audit("source.response", {
            source: "creem",
            step: "products",
            page,
            path: new URL(url instanceof Request ? url.url : String(url))
              .pathname,
            status: response.status,
            durationMs: Date.now() - started,
            requestId:
              response.headers.get("x-request-id") ??
              response.headers.get("request-id"),
          });
          if (response.ok) {
            try {
              recordCreemShape(await response.clone().json(), page);
            } catch {
              audit("source.response_shape", {
                source: "creem",
                step: "products",
                page,
                responseShape: "invalid_json",
              });
            }
          }
          return response;
        },
      }),
      apiKey,
      serverIdx: isTest ? 1 : 0,
    });

    const products: CreemProduct[] = [];
    const pageSize = 50;

    while (true) {
      const result = await creem.products.search(page, pageSize);
      validateCreemPage(result, page);
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
  });
}
