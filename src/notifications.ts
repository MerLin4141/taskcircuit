export interface NotificationDeliveryInput {
  deliveryId: string;
  notificationId: string;
  kind: string;
  severity: string;
  workItemId: string;
  interactionId: string | null;
  title: string;
  body: string;
}
export interface NotificationChannel {
  id: string;
  deliver(input: NotificationDeliveryInput): Promise<{ ok: boolean }>;
}
export class LocalConsoleChannel implements NotificationChannel {
  constructor(public id = "local") {}
  async deliver(input: NotificationDeliveryInput): Promise<{ ok: boolean }> {
    console.log(
      JSON.stringify({
        component: "notification",
        deliveryId: input.deliveryId,
        kind: input.kind,
        severity: input.severity,
        workItemId: input.workItemId,
        title: input.title,
        body: input.body,
      }),
    );
    return { ok: true };
  }
}
export interface HubOptions {
  dispatcherPollMs?: number;
  streamPollMs?: number;
  streamHeartbeatMs?: number;
  channels?: Record<string, NotificationChannel>;
}
