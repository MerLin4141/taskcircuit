import {
  isIntegrationSecretEnv,
  resolveIntegrationSecret,
} from "../../integrations/environment.js";
import {
  includesSecret,
  parseWebhookObject,
  submitWebhook,
  verifyWebhookSignature,
  webhookError,
  webhookIdentity,
} from "../../integrations/http-webhook.js";
import type { SourcePluginV2 } from "../types.js";

const invalid = () => {
  throw new Error("webhook_config_invalid");
};
const token = /^[!#$%&'*+.^_\x60|~0-9a-z-]{1,64}$/;

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

export const webhookPlugin: SourcePluginV2 = {
  manifest: { id: "webhook", kind: "source", apiVersion: 2, version: "0.4.0" },
  http: true,
  createSource(input, host) {
    const config = webhookConfig(input);
    const value = resolveIntegrationSecret(config.secretEnv);
    const secret = Buffer.from(value);
    let unregister: (() => void) | undefined;
    return {
      async start(signal) {
        if (!host.registerHttpHandler)
          throw new Error("integration_ingress_required");
        unregister = host.registerHttpHandler(async (request) => {
          if (
            !verifyWebhookSignature(
              request.headers["x-taskcircuit-signature-256"],
              request.body,
              secret,
            )
          )
            return webhookError(401);
          const deliveryId = request.headers[config.deliveryHeader];
          if (!webhookIdentity(deliveryId, 256) || deliveryId.includes(value))
            return webhookError(400);
          const payload = parseWebhookObject(request.body);
          if (!payload || includesSecret(payload, value))
            return webhookError(400);
          let correlationKey: string | undefined;
          if (
            config.correlationField &&
            Object.hasOwn(payload, config.correlationField)
          ) {
            const field = payload[config.correlationField];
            if (!webhookIdentity(field, 512)) return webhookError(400);
            correlationKey = field;
          }
          if (signal.aborted || request.signal.aborted)
            return webhookError(503);
          return submitWebhook(host, {
            sourceEventId: deliveryId,
            type: config.eventType,
            payload,
            ...(correlationKey === undefined ? {} : { correlationKey }),
          });
        });
      },
      async stop() {
        unregister?.();
        secret.fill(0);
      },
    };
  },
};
