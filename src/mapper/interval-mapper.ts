import type { PancakeBillingPeriod } from "../utils/types.js";

export interface IntervalMappingResult {
  billingPeriod: PancakeBillingPeriod;
  supported: true;
}

export interface IntervalMappingUnsupported {
  supported: false;
  reason: string;
}

export type IntervalMapping =
  IntervalMappingResult | IntervalMappingUnsupported;

export function mapInterval(
  interval: string,
  intervalCount: number
): IntervalMapping {
  if (interval === "week" && intervalCount === 1) {
    return { billingPeriod: "weekly", supported: true };
  }
  if (interval === "month" && intervalCount === 1) {
    return { billingPeriod: "monthly", supported: true };
  }
  if (interval === "month" && intervalCount === 3) {
    return { billingPeriod: "quarterly", supported: true };
  }
  if (interval === "year" && intervalCount === 1) {
    return { billingPeriod: "yearly", supported: true };
  }

  const label =
    intervalCount === 1
      ? `every ${interval}`
      : `every ${intervalCount} ${interval}s`;

  return {
    supported: false,
    reason: `Unsupported billing interval: ${label}`,
  };
}
