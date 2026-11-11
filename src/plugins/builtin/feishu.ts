import { createHmac } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { resolveIntegrationSecret } from "../../integrations/environment.js";
import type { NotificationDeliveryInput } from "../../notifications.js";
import { CHANNEL_API_VERSION, type ChannelPluginV2 } from "../types.js";

const TEXT_LIMIT = 12 * 1024;
const REQUEST_LIMIT = 20_000;
const RESPONSE_LIMIT = 64 * 1024;
const hookPattern =
  /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/([A-Za-z0-9_-]+)$/;
const headings = new Map([
  ["interaction_required", "TaskCircuit 需要输入"],
  ["work_item_failed", "TaskCircuit 执行失败"],
  ["work_item_completed", "TaskCircuit 已完成"],
]);

function cleanText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function escapedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value)) - 2;
}

function truncate(value: string, bytes: number, jsonBytes: number): string {
  let end = 0;
  for (const char of value) {
    bytes -= Buffer.byteLength(char);
    jsonBytes -= escapedBytes(char);
    if (bytes < 0 || jsonBytes < 0) break;
    end += char.length;
  }
  return value.slice(0, end);
}

async function accepted(response: Response): Promise<boolean> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return false;
  }
  if (!response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) {
        void reader.cancel().catch(() => {});
        return false;
      }
      chunks.push(value);
    }
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return (
      !!result &&
      typeof result === "object" &&
      "code" in result &&
      result.code === 0
    );
  } finally {
    reader.releaseLock();
  }
}

export function createFeishuPlugin({
  transport = globalThis.fetch,
  now = Date.now,
}: { transport?: typeof fetch; now?: () => number } = {}): ChannelPluginV2 {
  return {
    manifest: {
      id: "feishu-channel",
      kind: "channel",
      apiVersion: CHANNEL_API_VERSION,
      version: "0.4.0",
    },
    createChannel({ id, config }, host) {
      if (
        Object.keys(config).some(
          (key) =>
            !["webhookUrlEnv", "signingSecretEnv", "timeoutMs"].includes(key),
        )
      )
        throw new Error("feishu_channel_config_invalid");
      const timeout = config.timeoutMs === undefined ? 5000 : config.timeoutMs;
      if (
        typeof timeout !== "number" ||
        !Number.isInteger(timeout) ||
        timeout < 1000 ||
        timeout > 10000
      )
        throw new Error("feishu_timeout_invalid");
      const url = resolveIntegrationSecret(config.webhookUrlEnv);
      const secret = resolveIntegrationSecret(config.signingSecretEnv);
      const hook = hookPattern.exec(url);
      if (!hook || url.trim() !== url)
        throw new Error("feishu_webhook_url_invalid");
      const token = hook[1];
      const safeText = (value: string) =>
        [url, secret, token].reduce(
          (text, credential) => text.replaceAll(credential, "[已隐藏]"),
          cleanText(value),
        );

      function request(
        input: NotificationDeliveryInput,
        heading: string,
      ): string {
        const timestamp = String(Math.floor(now() / 1000));
        const sign = createHmac("sha256", timestamp + "\n" + secret).digest(
          "base64",
        );
        const payload = {
          timestamp,
          sign,
          msg_type: "text",
          content: { text: "" },
        };
        const prefix = heading + "\n";
        const instructions =
          input.kind === "interaction_required"
            ? "\n请在运行 TaskCircuit 的机器上使用：\ntaskcircuit inbox\ntaskcircuit answer"
            : "";
        const suffix =
          "\nWork Item " + safeText(input.workItemId) + instructions;
        const fixed = prefix + "\n" + suffix;
        const textBudget = TEXT_LIMIT - Buffer.byteLength(fixed);
        const jsonBudget =
          REQUEST_LIMIT -
          1 -
          Buffer.byteLength(JSON.stringify(payload)) -
          escapedBytes(fixed);
        const title = truncate(
          safeText(input.title),
          Math.min(1024, textBudget),
          Math.min(2048, jsonBudget),
        );
        const body = truncate(
          safeText(input.body),
          textBudget - Buffer.byteLength(title),
          jsonBudget - escapedBytes(title),
        );
        payload.content.text = prefix + title + "\n" + body + suffix;
        const serialized = JSON.stringify(payload);
        if (
          Buffer.byteLength(serialized) >= REQUEST_LIMIT ||
          Buffer.byteLength(payload.content.text) > TEXT_LIMIT
        )
          throw new Error("feishu_message_too_large");
        return serialized;
      }

      return {
        id,
        async deliver(input) {
          const heading = headings.get(input.kind);
          if (!heading || host.signal.aborted) return { ok: false };
          let ok = false;
          try {
            const body = request(input, heading);
            const signal = AbortSignal.any([
              host.signal,
              AbortSignal.timeout(timeout),
            ]);
            const response = await transport(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              redirect: "error",
              signal,
              body,
            });
            ok = (await accepted(response)) && !signal.aborted;
          } catch {
            // Transport and parse errors may embed webhook credentials or provider data.
          }
          if (!host.signal.aborted)
            host.reportHealth(ok ? "healthy" : "degraded");
          return { ok };
        },
      };
    },
  };
}
