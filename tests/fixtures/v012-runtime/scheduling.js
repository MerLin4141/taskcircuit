import { CronExpressionParser } from "cron-parser";
export const systemClock = { now: () => Date.now() };
export function validPolicy(p) {
    if (!p || typeof p !== "object")
        return false;
    const x = p;
    return (Number.isInteger(x.maxAttempts) &&
        x.maxAttempts >= 1 &&
        x.maxAttempts <= 100 &&
        ["fixed", "exponential"].includes(x.strategy) &&
        Number.isInteger(x.initialDelaySeconds) &&
        x.initialDelaySeconds >= 1 &&
        x.initialDelaySeconds <= 31536000 &&
        Number.isInteger(x.maxDelaySeconds) &&
        x.maxDelaySeconds >= x.initialDelaySeconds &&
        x.maxDelaySeconds <= 31536000);
}
export function retryDelay(p, attempt) {
    return Math.min(p.maxDelaySeconds, p.initialDelaySeconds *
        (p.strategy === "fixed" ? 1 : 2 ** Math.min(attempt - 1, 53)));
}
export function nextCron(expression, timezone, now) {
    if (expression.trim().split(/\s+/).length !== 5 ||
        /(^|[ ,/\-])H(?=$|[ ,/\-(])/i.test(expression))
        throw new Error("Cron 必须是确定性的五字段表达式");
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return CronExpressionParser.parse(expression, {
        currentDate: new Date(now),
        tz: timezone,
    })
        .next()
        .toDate()
        .toISOString();
}
export function validInstant(value) {
    return (typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        Number.isFinite(Date.parse(value)));
}
