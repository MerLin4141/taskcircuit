import { createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { TaskCircuitError } from "../domain.js";
import type {
  SourceHost,
  SourceHttpResponse,
  SourceSubmission,
} from "../plugins/types.js";

const credential =
  /(?:^sk-|^ghp_|^github_pat_|\bBearer\s|-----BEGIN .*PRIVATE KEY-----)/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function verifyWebhookSignature(
  signature: string | undefined,
  body: Uint8Array,
  secret: Uint8Array,
): boolean {
  return (
    !!signature &&
    /^sha256=[a-fA-F0-9]{64}$/.test(signature) &&
    timingSafeEqual(
      createHmac("sha256", secret).update(body).digest(),
      Buffer.from(signature.slice(7), "hex"),
    )
  );
}

export function webhookIdentity(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !credential.test(value)
  );
}

export function webhookObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWebhookObject(
  body: Uint8Array,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(utf8.decode(body));
    return webhookObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function includesSecret(payload: object, secret: string): boolean {
  const pending: unknown[] = [payload];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes(secret)) return true;
    if (item && typeof item === "object") {
      for (const [key, value] of Object.entries(item)) {
        if (key.includes(secret)) return true;
        pending.push(value);
      }
    }
  }
  return false;
}

export function webhookError(status: number): SourceHttpResponse {
  const errors: Record<number, string> = {
    400: "invalid_request",
    401: "authentication_failed",
    403: "forbidden",
    413: "payload_too_large",
    503: "unavailable",
  };
  return { status, body: { error: errors[status] ?? "internal_error" } };
}

export async function submitWebhook(
  host: SourceHost,
  input: SourceSubmission,
): Promise<SourceHttpResponse> {
  try {
    const result = await host.submit(input);
    if (result.status === "conflict")
      return { status: 409, body: { error: "delivery_conflict" } };
    return {
      status: result.status === "duplicate" ? 200 : 202,
      body: { status: result.status },
    };
  } catch (error) {
    return webhookError(error instanceof TaskCircuitError ? error.status : 500);
  }
}
