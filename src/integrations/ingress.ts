import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { TaskCircuitError } from "../domain.js";
import type { SourceHttpHandler } from "../plugins/types.js";

export const RAW_BODY_LIMIT = 131072;
const REQUEST_MS = 7000;
const READ_MS = 2000;
const DRAIN_MS = 200;

export interface IntegrationIngressConfig {
  port: number;
  maxConcurrent?: number;
}
type Registration = {
  handler?: SourceHttpHandler;
  failed?: () => void;
};

function instancePath(implementation: string, instance: string): string {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (!id.test(implementation) || !id.test(instance))
    throw new Error("integration_route_invalid");
  return "/integrations/" + implementation + "/" + instance;
}

function headers(request: IncomingMessage): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = Object.create(null);
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    values[name] = Object.hasOwn(values, name)
      ? undefined
      : request.rawHeaders[i + 1];
  }
  return values;
}

function rawBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      request.removeListener("data", data);
      request.removeListener("end", ended);
      request.removeListener("aborted", aborted);
      request.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
      clearTimeout(timer);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > RAW_BODY_LIMIT)
        finish(new TaskCircuitError("body_too_large", "请求内容过大", 413));
      else chunks.push(chunk);
    };
    const ended = () => finish();
    const aborted = () =>
      finish(new TaskCircuitError("unavailable", "请求不可用", 503));
    const failed = () =>
      finish(new TaskCircuitError("invalid_request", "请求格式不正确", 400));
    const timer = setTimeout(aborted, READ_MS);
    request.on("data", data);
    request.once("end", ended);
    request.once("aborted", aborted);
    request.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: Record<string, string>,
) {
  if (response.destroyed || response.writableEnded) return;
  if (status === 204) {
    response.writeHead(status, { connection: "close" }).end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    connection: "close",
  });
  response.end(JSON.stringify(body));
}

export class IntegrationIngress {
  private readonly routes = new Map<string, Registration>();
  private readonly requests = new Map<AbortController, Promise<void>>();
  private accepting = false;
  private closing = false;
  private drained?: Promise<void>;
  private closed?: Promise<void>;
  private readonly server = createServer(
    {
      requestTimeout: REQUEST_MS,
      headersTimeout: READ_MS,
      connectionsCheckingInterval: 250,
      maxHeaderSize: 16384,
    },
    (request, response) => {
      void this.handle(request, response);
    },
  );

  constructor(private readonly config: IntegrationIngressConfig) {
    this.server.on("error", () => {
      this.accepting = false;
      for (const registration of this.routes.values()) registration.failed?.();
    });
  }

  reserve(implementation: string, instance: string) {
    const path = instancePath(implementation, instance);
    if (this.routes.has(path)) throw new Error("integration_route_duplicate");
    this.routes.set(path, {});
  }

  register(
    implementation: string,
    instance: string,
    handler: SourceHttpHandler,
    signal: AbortSignal,
    failed: () => void,
  ): () => void {
    const entry = this.routes.get(instancePath(implementation, instance));
    if (
      this.closing ||
      signal.aborted ||
      !entry ||
      typeof handler !== "function"
    )
      throw new Error("integration_route_invalid");
    if (entry.failed) throw new Error("integration_route_duplicate");
    entry.handler = handler;
    entry.failed = failed;
    const remove = () => {
      entry.handler = undefined;
    };
    signal.addEventListener("abort", remove, { once: true });
    return remove;
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error("integration_start_cancelled");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.server.removeListener("error", failed);
        this.server.removeListener("close", cancelled);
        this.server.removeListener("listening", listening);
      };
      const failed = () => {
        cleanup();
        reject(new Error("integration_listen_failed"));
      };
      const cancelled = () => {
        cleanup();
        reject(new Error("integration_start_cancelled"));
      };
      const listening = () => {
        cleanup();
        resolve();
      };
      this.server.once("error", failed);
      this.server.once("close", cancelled);
      this.server.once("listening", listening);
      this.server.listen(this.config.port, "127.0.0.1");
    });
    if (this.closing) throw new Error("integration_start_cancelled");
  }

  open() {
    if (!this.closing) this.accepting = true;
  }

  drain(): Promise<void> {
    this.accepting = false;
    this.closing = true;
    return (this.drained ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this.requests.values()]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, DRAIN_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        for (const controller of this.requests.keys()) controller.abort();
      }
    })());
  }

  close(): Promise<void> {
    return (this.closed ??= (async () => {
      await this.drain();
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
      this.routes.clear();
    })());
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    // Peer disconnects can still emit errors after an early response.
    request.on("error", () => {});
    const route = this.routes.get(request.url ?? "");
    if (request.method !== "POST" || !route) {
      send(response, 404, { error: "not_found" });
      request.resume();
      return;
    }
    if (
      !this.accepting ||
      !route.handler ||
      this.requests.size >= (this.config.maxConcurrent ?? 32)
    ) {
      send(response, 503, { error: "unavailable" });
      request.resume();
      return;
    }
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.requests.set(controller, finished);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const inputHeaders = headers(request);
      const contentType = inputHeaders["content-type"] ?? "";
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType) ||
        (Object.hasOwn(inputHeaders, "content-encoding") &&
          inputHeaders["content-encoding"]?.toLowerCase() !== "identity")
      ) {
        send(response, 415, { error: "unsupported_media" });
        request.resume();
        return;
      }
      timer = setTimeout(() => {
        controller.abort();
        send(response, 503, { error: "unavailable" });
      }, REQUEST_MS);
      const body = await rawBody(request, controller.signal);
      if (controller.signal.aborted || !route.handler) {
        send(response, 503, { error: "unavailable" });
        return;
      }
      const result = await route.handler({
        headers: inputHeaders,
        body,
        signal: controller.signal,
      });
      if (!controller.signal.aborted)
        send(response, result.status, result.body);
    } catch (error) {
      const status = error instanceof TaskCircuitError ? error.status : 500;
      send(response, status, {
        error:
          status === 413
            ? "body_too_large"
            : status === 503
              ? "unavailable"
              : status === 400
                ? "invalid_request"
                : "internal_error",
      });
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
      finish();
    }
  }
}
