import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

let file: string | undefined;
const secrets = new Set<string>();
export function registerSecret(value?: string) {
  if (value) {
    secrets.add(value);
    const compact = value.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "");
    if (compact.length > 128) secrets.add(compact);
  }
}
export function redact(value: string): string {
  let result = value;
  for (const secret of secrets)
    result = result.split(secret).join("[REDACTED]");
  return result
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED]"
    )
    .replace(/\b(?:sk_(?:test|live)_|creem_)[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[REDACTED]");
}
export function startAudit(path?: string): string {
  file = undefined;
  const target = resolve(
    path ??
      `.pancake-migrate/logs/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`
  );
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, "", { flag: "wx", mode: 0o600 });
  file = target;
  audit("run.started");
  return target;
}
export function audit(event: string, fields: Record<string, unknown> = {}) {
  if (!file) return;
  // Only explicitly selected diagnostics are accepted; never serialize requests/configs.
  const allowed = new Set([
    "requestNumber",
    "step",
    "sdkVersion",
    "toolVersion",
    "nodeVersion",
    "category",
    "code",
    "page",
    "count",
    "responseShape",
    "responseDate",
    "storeCreationId",
    "source",
    "merchantId",
    "storeId",
    "productId",
    "sourceProductId",
    "name",
    "path",
    "status",
    "requestId",
    "durationMs",
    "attempt",
    "error",
    "hasProdVersion",
    "verified",
    "failed",
    "created",
    "message",
  ]);
  // Redact before JSON escaping, which otherwise hides newlines/quotes in secrets.
  // Diagnostics are scalar values only: never accept nested request/config objects.
  const safe = Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([key, value]) =>
          allowed.has(key) &&
          (value === null ||
            ["string", "number", "boolean"].includes(typeof value))
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? redact(value) : value,
      ])
  );
  appendFileSync(
    file,
    JSON.stringify({
      time: new Date().toISOString(),
      event: redact(event),
      ...safe,
    }) + "\n"
  );
}
export function endAudit() {
  file = undefined;
  secrets.clear();
}
