export class LocalConsoleChannel {
    id;
    constructor(id = "local") {
        this.id = id;
    }
    async deliver(input) {
        console.log(JSON.stringify({
            component: "notification",
            deliveryId: input.deliveryId,
            kind: input.kind,
            severity: input.severity,
            workItemId: input.workItemId,
            title: input.title,
            body: input.body,
        }));
        return { ok: true };
    }
}
