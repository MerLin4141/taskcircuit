import { createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { TaskCircuitError } from "../../domain.js";
import { isIntegrationSecretEnv } from "../../integrations/environment.js";
import type { SourcePluginV2, SourceHttpResponse } from "../types.js";

const invalid = () => {
  throw new Error("webhook_config_invalid");
};
const token = /^[!#$%&'*+.^_\x60|~0-9a-z-]{1,64}$/;
const credential =
  /(?:^sk-|^ghp_|^github_pat_|\bBearer\s|-----BEGIN .*PRIVATE KEY-----)/i;

function webhookConfig(config: Record<string, unknown>) {
  if (
    Object.keys(config).some(
      (key) =>
        ![
          "secretEnv",
          "eventType",
          "deliveryHeader",
          "correlationField",
        ].includes(key),
    ) ||
    !isIntegrationSecretEnv(config.secretEnv) ||
    typeof config.eventType !== "string" ||
    config.eventType.length > 128 ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(config.eventType)
  )
    return invalid();
  const deliveryHeader =
    config.deliveryHeader === undefined
      ? "x-taskcircuit-delivery"
      : typeof config.deliveryHeader === "string"
        ? config.deliveryHeader.toLowerCase()
        : "";
  if (
    !token.test(deliveryHeader) ||
    [
      "authorization",
      "cookie",
      "content-type",
      "content-length",
      "content-encoding",
      "connection",
      "transfer-encoding",
      "x-taskcircuit-signature-256",
    ].includes(deliveryHeader)
  )
    return invalid();
  if (
    config.correlationField !== undefined &&
    (typeof config.correlationField !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(config.correlationField))
  )
    return invalid();
  return {
    secretEnv: config.secretEnv,
    eventType: config.eventType,
    deliveryHeader,
    correlationField: config.correlationField as string | undefined,
  };
}

function identity(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !credential.test(value)
  );
}

function includesSecret(payload: object, secret: string): boolean {
  const pending: unknown[] = [payload];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes(secret)) return true;
    if (item && typeof item === "object")
      for (const [key, value] of Object.entries(item)) {
        if (key.includes(secret)) return true;
        pending.push(value);
      }
  }
  return false;
}

export const webhookPlugin: SourcePluginV2 = {
  manifest: { id: "webhook", kind: "source", apiVersion: 2, version: "0.4.0" },
  http: true,
  createSource(input, host) {
    const config = webhookConfig(input);
    const value = process.env[config.secretEnv];
    if (!value || !value.trim()) throw new Error("webhook_secret_unavailable");
    const secret = Buffer.from(value);
    let unregister: (() => void) | undefined;
    return {
      async start(signal) {
        if (!host.registerHttpHandler)
          throw new Error("integration_ingress_required");
        unregister = host.registerHttpHandler(
          async (request): Promise<SourceHttpResponse> => {
            const signature = request.headers["x-taskcircuit-signature-256"];
            if (
              !signature ||
              !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
              !timingSafeEqual(
                createHmac("sha256", secret).update(request.body).digest(),
                Buffer.from(signature.slice(7), "hex"),
              )
            )
              return { status: 401, body: { error: "authentication_failed" } };
            const deliveryId = request.headers[config.deliveryHeader];
            if (!identity(deliveryId, 256) || deliveryId.includes(value))
              return { status: 400, body: { error: "invalid_request" } };
            let payload: unknown;
            try {
              payload = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(request.body),
              );
            } catch {
              return { status: 400, body: { error: "invalid_request" } };
            }
            if (
              !payload ||
              typeof payload !== "object" ||
              Array.isArray(payload) ||
              includesSecret(payload, value)
            )
              return { status: 400, body: { error: "invalid_request" } };
            let correlationKey: string | undefined;
            if (
              config.correlationField &&
              Object.hasOwn(payload, config.correlationField)
            ) {
              const field = (payload as Record<string, unknown>)[
                config.correlationField
              ];
              if (!identity(field, 512))
                return { status: 400, body: { error: "invalid_request" } };
              correlationKey = field;
            }
            if (signal.aborted || request.signal.aborted)
              return { status: 503, body: { error: "unavailable" } };
            try {
              const result = await host.submit({
                sourceEventId: deliveryId,
                type: config.eventType,
                payload,
                ...(correlationKey === undefined ? {} : { correlationKey }),
              });
              if (result.status === "conflict")
                return { status: 409, body: { error: "delivery_conflict" } };
              return {
                status: result.status === "duplicate" ? 200 : 202,
                body: { status: result.status },
              };
            } catch (error) {
              const status =
                error instanceof TaskCircuitError ? error.status : 500;
              return {
                status,
                body: {
                  error:
                    status === 503
                      ? "unavailable"
                      : status === 413
                        ? "payload_too_large"
                        : status === 400
                          ? "invalid_request"
                          : "internal_error",
                },
              };
            }
          },
        );
      },
      async stop() {
        unregister?.();
        secret.fill(0);
      },
    };
  },
};
