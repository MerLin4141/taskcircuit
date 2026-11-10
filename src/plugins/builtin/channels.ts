import { LocalConsoleChannel } from "../../notifications.js";
import { PLUGIN_API_VERSION, type ChannelPlugin } from "../types.js";

export const localConsolePlugin: ChannelPlugin = {
  manifest: {
    id: "local-console",
    kind: "channel",
    apiVersion: PLUGIN_API_VERSION,
    version: "0.2.0",
  },
  createChannel({ id }) {
    return new LocalConsoleChannel(id);
  },
};
