import type { Config } from "../config.js";
import type { NotificationChannel } from "../notifications.js";
import type { PluginRegistry } from "./registry.js";
import {
  isChannelV2,
  type ChannelHealth,
  type ChannelInstance,
} from "./types.js";

async function stopInstance(instance: ChannelInstance): Promise<void> {
  if (!instance.stop) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => instance.stop?.())
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function bindChannels(
  registry: PluginRegistry,
  configured: Config["channels"],
  injected?: Record<string, NotificationChannel>,
) {
  const controller = new AbortController();
  const channels: Record<string, NotificationChannel> = Object.create(null);
  const instances: ChannelInstance[] = [];
  const health: {
    id: string;
    implementation: string;
    apiVersion: 2;
    state: ChannelHealth;
  }[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    return (stopping ??= Promise.all(instances.map(stopInstance)).then(
      () => {},
    ));
  };
  try {
    if (injected) Object.assign(channels, injected);
    else
      for (const [id, { type, config }] of Object.entries(
        configured ?? { local: { type: "local-console" } },
      )) {
        const plugin = registry.getChannel(type);
        if (!isChannelV2(plugin)) {
          channels[id] = plugin.createChannel({ id });
          continue;
        }
        const status = {
          id,
          implementation: plugin.manifest.id,
          apiVersion: 2 as const,
          state: "healthy" as ChannelHealth,
        };
        const instance = plugin.createChannel(
          { id, config: config ?? {} },
          {
            signal: controller.signal,
            reportHealth(state) {
              if (
                !controller.signal.aborted &&
                (state === "healthy" ||
                  state === "degraded" ||
                  state === "failed")
              )
                status.state = state;
            },
          },
        );
        instances.push(instance);
        channels[id] = instance;
        health.push(status);
      }
  } catch (error) {
    void stop();
    throw error;
  }
  return {
    channels,
    signal: controller.signal,
    stop,
    health: () =>
      health.length ? { channels: health.map((entry) => ({ ...entry })) } : {},
  };
}
