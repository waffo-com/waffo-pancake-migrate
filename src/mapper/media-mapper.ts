import type { PancakeMediaItem } from "../utils/types.js";

export function mapMedia(stripeImages: string[]): PancakeMediaItem[] {
  return stripeImages.map((url) => ({
    type: "image" as const,
    url,
  }));
}
