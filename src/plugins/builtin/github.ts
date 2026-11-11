import { TaskCircuitError } from "../../domain.js";
import { EVENT_PAYLOAD_LIMIT } from "../../event-core.js";
import { resolveIntegrationSecret } from "../../integrations/environment.js";
import {
  includesSecret,
  parseWebhookObject,
  submitWebhook,
  verifyWebhookSignature,
  webhookError,
  webhookIdentity,
  webhookObject,
} from "../../integrations/http-webhook.js";
import type { SourceHttpResponse, SourcePluginV2 } from "../types.js";

type Row = Record<string, unknown>;
const MAX_IDS = 100;
const BODY_LIMIT = 32768;
const ignore: SourceHttpResponse = { status: 204, body: {} };

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function allowlist(value: unknown): Set<number> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_IDS ||
    !value.every(positiveId) ||
    new Set(value).size !== value.length
  )
    throw new Error("github_config_invalid");
  return new Set(value);
}

function invalid(): never {
  throw new TaskCircuitError(
    "github_payload_invalid",
    "Invalid GitHub payload",
    400,
  );
}

function entity(value: unknown): Row & { id: number } {
  if (!webhookObject(value) || !positiveId(value.id)) return invalid();
  return { ...value, id: value.id };
}

function display(value: unknown, limit: number): string {
  if (!webhookIdentity(value, limit)) return invalid();
  return value;
}

function person(value: Row & { id: number }) {
  return {
    id: value.id,
    ...(value.login === undefined ? {} : { login: display(value.login, 128) }),
  };
}

function link(value: unknown): { htmlUrl?: string } {
  if (value === undefined || value === null) return {};
  const htmlUrl = display(value, 2048);
  try {
    const url = new URL(htmlUrl);
    if (url.protocol === "https:" && !url.username && !url.password)
      return { htmlUrl };
  } catch {
    return invalid();
  }
  return invalid();
}

function title(value: unknown): string {
  if (typeof value !== "string" || !value.length) return invalid();
  const prefix = value.slice(0, 512);
  // Avoid splitting a UTF-16 surrogate pair at the title limit.
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

function bodyPrefix(value: string, escapedLimit: number): string {
  let rawBytes = 0;
  let escapedBytes = 0;
  let length = 0;
  for (const character of value) {
    rawBytes += Buffer.byteLength(character);
    escapedBytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (rawBytes > BODY_LIMIT || escapedBytes > escapedLimit) break;
    length += character.length;
  }
  return value.slice(0, length);
}

function labels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid();
  return value.slice(0, 50).map((label: unknown) => {
    if (!webhookObject(label)) return invalid();
    return display(label.name, 128);
  });
}

function project(
  payload: Row,
  repository: Row & { id: number },
  sender: Row & { id: number },
  isComment: boolean,
) {
  const issue = entity(payload.issue);
  if (!positiveId(issue.number)) return invalid();
  const common = {
    provider: "github",
    repository: {
      id: repository.id,
      ...(!isComment || repository.full_name !== undefined
        ? { fullName: display(repository.full_name, 255) }
        : {}),
      ...link(repository.html_url),
    },
    issue: {
      id: issue.id,
      number: issue.number,
      title: title(issue.title),
      ...link(issue.html_url),
    },
    sender: person(sender),
  };
  const correlationKey = "github:" + repository.id + ":issue:" + issue.number;
  if (isComment) {
    const comment = entity(payload.comment);
    if (typeof comment.body !== "string") return invalid();
    const projected = {
      ...common,
      comment: {
        id: comment.id,
        body: "",
        ...link(comment.html_url),
        author: person(entity(comment.user)),
      },
    };
    projected.comment.body = bodyPrefix(
      comment.body,
      EVENT_PAYLOAD_LIMIT - Buffer.byteLength(JSON.stringify(projected)),
    );
    return {
      type: "github.issue_comment.created",
      payload: projected,
      correlationKey,
    };
  }
  const body = issue.body ?? "";
  if (typeof body !== "string") return invalid();
  const projected = {
    ...common,
    issue: {
      ...common.issue,
      body: "",
      author: person(entity(issue.user)),
      labels: labels(issue.labels),
    },
  };
  projected.issue.body = bodyPrefix(
    body,
    EVENT_PAYLOAD_LIMIT - Buffer.byteLength(JSON.stringify(projected)),
  );
  return { type: "github.issue.opened", payload: projected, correlationKey };
}

export const githubPlugin: SourcePluginV2 = {
  manifest: { id: "github", kind: "source", apiVersion: 2, version: "0.4.0" },
  http: true,
  createSource(config, host) {
    if (
      Object.keys(config).some(
        (key) =>
          !["secretEnv", "allowedRepositoryIds", "allowedSenderIds"].includes(
            key,
          ),
      )
    )
      throw new Error("github_config_invalid");
    const repositories = allowlist(config.allowedRepositoryIds);
    const senders = allowlist(config.allowedSenderIds);
    const secret = resolveIntegrationSecret(config.secretEnv);
    const key = Buffer.from(secret);
    let unregister: (() => void) | undefined;
    return {
      async start(signal) {
        if (!host.registerHttpHandler)
          throw new Error("integration_ingress_required");
        unregister = host.registerHttpHandler(async (request) => {
          if (
            !verifyWebhookSignature(
              request.headers["x-hub-signature-256"],
              request.body,
              key,
            )
          )
            return webhookError(401);
          const event = request.headers["x-github-event"];
          const payload = parseWebhookObject(request.body);
          if (!event || !/^[a-z][a-z0-9_]{0,63}$/.test(event) || !payload)
            return webhookError(400);
          try {
            if (event === "ping") {
              if (
                payload.repository !== undefined &&
                !repositories.has(entity(payload.repository).id)
              )
                return webhookError(403);
              return ignore;
            }
            if (event !== "issues" && event !== "issue_comment") return ignore;
            if (typeof payload.action !== "string" || !payload.action.length)
              return webhookError(400);
            const isComment = event === "issue_comment";
            if (payload.action !== (isComment ? "created" : "opened"))
              return ignore;
            if (
              Object.hasOwn(payload, "pull_request") ||
              (webhookObject(payload.issue) &&
                Object.hasOwn(payload.issue, "pull_request"))
            )
              return ignore;
            const delivery = request.headers["x-github-delivery"];
            if (!webhookIdentity(delivery, 256) || delivery.includes(secret))
              return webhookError(400);
            const repository = entity(payload.repository);
            const sender = entity(payload.sender);
            if (!repositories.has(repository.id) || !senders.has(sender.id))
              return webhookError(403);
            const submission = project(payload, repository, sender, isComment);
            if (includesSecret(submission.payload, secret))
              return webhookError(400);
            if (signal.aborted || request.signal.aborted)
              return webhookError(503);
            return submitWebhook(host, {
              sourceEventId: delivery,
              ...submission,
            });
          } catch (error) {
            return webhookError(
              error instanceof TaskCircuitError ? error.status : 500,
            );
          }
        });
      },
      async stop() {
        unregister?.();
        key.fill(0);
      },
    };
  },
};
