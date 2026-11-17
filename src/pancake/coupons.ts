import { pancakeClient, query, readBack, signedPost } from "./client.js";
import { audit, redact } from "../utils/audit.js";
import type {
  CouponMigrationResult,
  CouponPlan,
  MigrationResult,
} from "../utils/types.js";

interface CouponReadBack {
  id: string;
  storeId: string;
  name: string;
  code: string;
  status: string;
  discountType: string;
  percentOff: number | null;
  amountOff: Array<{ currency: string; display: string }> | null;
  duration: string;
  durationInPeriods: number | null;
  productIds: string[];
  maxRedemptions: number | null;
  redeemBy: string | null;
}

const sameInstant = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

export function couponMatches(
  actual: CouponReadBack | null,
  expected: { id: string; storeId: string; productIds: string[] },
  plan: CouponPlan
): boolean {
  if (!actual) return false;
  const amountMatches =
    plan.discount.type === "percentage"
      ? actual.percentOff === plan.discount.percentOff
      : Array.isArray(actual.amountOff) &&
        actual.amountOff.length ===
          Object.keys(plan.discount.amountOff).length &&
        Object.entries(plan.discount.amountOff).every(([currency, amount]) =>
          actual.amountOff!.some(
            (a) =>
              a.currency === currency && Number(a.display) === Number(amount)
          )
        );
  return (
    actual.id === expected.id &&
    actual.storeId === expected.storeId &&
    actual.name === plan.name &&
    actual.code === plan.code.toUpperCase() &&
    actual.status === "active" &&
    actual.discountType === plan.discount.type &&
    amountMatches &&
    actual.duration === plan.duration &&
    (plan.duration !== "repeating" ||
      actual.durationInPeriods === plan.durationInPeriods) &&
    Array.isArray(actual.productIds) &&
    actual.productIds.length === expected.productIds.length &&
    expected.productIds.every((id) => actual.productIds.includes(id)) &&
    actual.maxRedemptions === plan.maxRedemptions &&
    sameInstant(actual.redeemBy, plan.redeemBy)
  );
}

export async function createPancakeCoupons(options: {
  coupons: CouponPlan[];
  products: MigrationResult[];
  merchantId: string;
  privateKey: string;
  storeId: string;
  onProgress?: (completed: number, total: number) => void;
}): Promise<CouponMigrationResult[]> {
  const { coupons, merchantId, privateKey, storeId, onProgress } = options;
  const client = pancakeClient(merchantId, privateKey);
  // Only verified products may be referenced: a restriction must never silently widen or shrink.
  const verified = new Map(
    options.products
      .filter((r) => r.success && r.pancakeProductId)
      .map((r) => [r.input.sourceProductId, r.pancakeProductId!] as const)
  );
  const results: CouponMigrationResult[] = [];
  for (const [index, plan] of coupons.entries()) {
    let couponId: string | undefined;
    try {
      const missing = plan.sourceProductIds.filter((id) => !verified.has(id));
      if (missing.length)
        throw new Error(
          `Not created: restricted product(s) ${missing.join(", ")} were not created and verified`
        );
      const productIds = plan.sourceProductIds.map((id) => verified.get(id)!);
      let created: { coupon?: { id?: unknown } } | undefined;
      try {
        created = await signedPost(client, "/v1/actions/coupon/create-coupon", {
          storeId,
          name: plan.name,
          code: plan.code,
          discount: plan.discount,
          duration: plan.duration,
          ...(plan.duration === "repeating"
            ? { durationInPeriods: plan.durationInPeriods }
            : {}),
          ...(productIds.length ? { productIds } : {}),
          maxRedemptions: plan.maxRedemptions,
          redeemBy: plan.redeemBy,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          /HTTP 409/.test(message)
            ? `${message} (code ${plan.code} is already used by an active coupon or promotion code in this store; check for an earlier migration)`
            : message
        );
      }
      if (
        typeof created?.coupon?.id !== "string" ||
        !created.coupon.id.startsWith("CPN_")
      )
        throw new Error("Invalid create-coupon response");
      couponId = created.coupon.id;
      audit("coupon.created", {
        storeId,
        couponId,
        name: plan.name,
        sourceDiscountId: plan.sourceDiscountId,
      });
      const expected = { id: couponId, storeId, productIds };
      await readBack(async () => {
        const { coupon } = await query<{ coupon: CouponReadBack | null }>(
          client,
          `query ($id: String!) { coupon(id: $id) { id storeId name code status discountType percentOff amountOff { currency display } duration durationInPeriods productIds maxRedemptions redeemBy } }`,
          { id: couponId }
        );
        if (!couponMatches(coupon, expected, plan))
          throw new Error(
            `Coupon ${couponId} was returned by create but read-back verification failed (store, code, status, discount, duration, products, limit or expiry). Do not recreate blindly.`
          );
      });
      audit("coupon.verified", { storeId, couponId });
      results.push({ plan, success: true, couponId });
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : String(error)
      );
      audit(couponId ? "coupon.unverified" : "coupon.failed", {
        storeId,
        couponId,
        sourceDiscountId: plan.sourceDiscountId,
        error: message,
      });
      results.push({ plan, success: false, couponId, error: message });
    }
    onProgress?.(index + 1, coupons.length);
  }
  return results;
}
