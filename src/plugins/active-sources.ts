import type { SourceInstanceConfig } from "../config.js";
import { TaskCircuitError } from "../domain.js";
import type { PluginRegistry } from "./registry.js";
import type { IntegrationIngress } from "../integrations/ingress.js";
import {
  isActiveSource,
  type SourceHealth,
  type SourceHttpHandler,
  type SourceInstance,
  type SourcePluginV2,
  type SourceSubmission,
  type SourceSubmitResult,
} from "./types.js";

const START_MS = 5000;
const STOP_MS = 1200;
const submissionKeys = new Set([
  "sourceEventId",
  "type",
  "payload",
  "correlationKey",
  "occurredAt",
]);

type Entry = {
  id: string;
  config: SourceInstanceConfig;
  plugin: SourcePluginV2;
  controller: AbortController;
  state: SourceHealth;
  reason?: "startup_failed" | "runtime_failed";
  stopFailure?: "stop_failed" | "stop_timeout";
  instance?: SourceInstance;
  stopping?: Promise<void>;
};

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("source_start_cancelled"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("source_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function validSubmission(input: SourceSubmission): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.hasOwn(input, "sourceEventId") &&
    Object.hasOwn(input, "type") &&
    Object.hasOwn(input, "payload") &&
    Reflect.ownKeys(input).every(
      (key) => typeof key === "string" && submissionKeys.has(key),
    )
  );
}

export function bindActiveSources(
  registry: PluginRegistry,
  configs: Record<string, SourceInstanceConfig> = {},
) {
  return Object.entries(configs).map(([id, config]) => {
    const plugin = registry.getSource(config.type);
    if (!isActiveSource(plugin) || typeof plugin.createSource !== "function")
      throw new Error(`source_instance_requires_api_2: ${id}`);
    return { id, config, plugin };
  });
}

export class ActiveSources {
  private readonly entries: Entry[];
  private accepting = false;
  private closing?: Promise<void>;

  constructor(
    bindings: ReturnType<typeof bindActiveSources>,
    private readonly submit: (
      sourceId: string,
      input: SourceSubmission,
    ) => SourceSubmitResult,
    private readonly ingress?: IntegrationIngress,
  ) {
    this.entries = bindings.map((binding) => ({
      ...binding,
      controller: new AbortController(),
      state: "starting",
    }));
  }

  health() {
    return this.entries.map(({ id, plugin, state, reason, stopFailure }) => ({
      id,
      implementation: plugin.manifest.id,
      apiVersion: plugin.manifest.apiVersion,
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(stopFailure === undefined ? {} : { stopFailure }),
    }));
  }

  async start() {
    const deadline = Date.now() + START_MS;
    try {
      for (const entry of this.entries) {
        if (this.closing) throw new Error("source_start_cancelled");
        try {
          await this.startEntry(entry, deadline);
        } catch {
          if (this.closing) throw new Error("source_start_cancelled");
          entry.state = "failed";
          entry.reason = "startup_failed";
          if (entry.config.required !== false)
            throw new Error(`source_start_failed: ${entry.id}`);
          entry.controller.abort();
          await this.stopEntry(entry);
        }
      }
      if (!this.closing) this.accepting = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async startEntry(entry: Entry, deadline: number) {
    if (Date.now() >= deadline) throw new Error("source_start_timeout");
    const fail = () => {
      if (entry.controller.signal.aborted) return;
      entry.state = "failed";
      entry.reason = "runtime_failed";
      entry.controller.abort();
      if (entry.instance) void this.stopEntry(entry);
    };
    const ingress = entry.plugin.http === true ? this.ingress : undefined;
    let httpRegistered = false;
    const instance = entry.plugin.createSource(
      structuredClone(entry.config.config ?? {}),
      Object.freeze({
        ...(ingress
          ? {
              registerHttpHandler: (handler: SourceHttpHandler) => {
                const unregister = ingress.register(
                  entry.plugin.manifest.id,
                  entry.id,
                  handler,
                  entry.controller.signal,
                  fail,
                );
                httpRegistered = true;
                return () => {
                  unregister();
                  httpRegistered = false;
                };
              },
            }
          : {}),
        submit: async (input: SourceSubmission) => {
          if (
            !this.accepting ||
            entry.controller.signal.aborted ||
            (entry.state !== "healthy" && entry.state !== "degraded")
          )
            throw new TaskCircuitError("source_unavailable", "来源未就绪", 503);
          if (!validSubmission(input))
            throw new TaskCircuitError(
              "source_event_invalid",
              "来源事件格式不正确",
              400,
            );
          try {
            return this.submit(entry.id, {
              sourceEventId: input.sourceEventId,
              type: input.type,
              payload: input.payload,
              ...(Object.hasOwn(input, "correlationKey")
                ? { correlationKey: input.correlationKey }
                : {}),
              ...(Object.hasOwn(input, "occurredAt")
                ? { occurredAt: input.occurredAt }
                : {}),
            });
          } catch (error) {
            if (error instanceof TaskCircuitError) throw error;
            throw new TaskCircuitError(
              "source_submit_failed",
              "来源事件接收失败",
              500,
            );
          }
        },
        reportHealth: (state: "healthy" | "degraded" | "failed") => {
          if (entry.controller.signal.aborted) return;
          if (state === "failed") fail();
          else if (
            (state === "healthy" || state === "degraded") &&
            (entry.state === "healthy" || entry.state === "degraded")
          )
            entry.state = state;
        },
      }),
    );
    if (
      !instance ||
      typeof instance.start !== "function" ||
      (instance.stop !== undefined && typeof instance.stop !== "function")
    )
      throw new Error("source_instance_invalid");
    entry.instance = instance;
    await withTimeout(
      Promise.resolve().then(() => {
        entry.controller.signal.throwIfAborted();
        return instance.start(entry.controller.signal);
      }),
      Math.max(0, deadline - Date.now()),
      entry.controller.signal,
    );
    if (entry.controller.signal.aborted)
      throw new Error("source_start_cancelled");
    if (ingress && !httpRegistered)
      throw new Error("integration_handler_required");
    entry.state = "healthy";
  }

  close(): Promise<void> {
    this.accepting = false;
    if (!this.closing) {
      this.closing = Promise.resolve().then(async () => {
        for (const entry of this.entries) entry.controller.abort();
        await Promise.all(this.entries.map((entry) => this.stopEntry(entry)));
      });
    }
    return this.closing;
  }

  private stopEntry(entry: Entry): Promise<void> {
    if (!entry.stopping)
      entry.stopping = (async () => {
        try {
          await withTimeout(
            Promise.resolve()
              .then(() => entry.instance?.stop?.())
              .catch(() => {
                entry.stopFailure = "stop_failed";
              }),
            STOP_MS,
          );
        } catch {
          entry.stopFailure = "stop_timeout";
        }
        if (entry.state !== "failed") entry.state = "stopped";
      })();
    return entry.stopping;
  }
}
