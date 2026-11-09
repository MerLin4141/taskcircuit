import { createHash } from "node:crypto";
// Version 1 hashes the JSON wire value with UTF-16-sorted object keys.
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new Error("invalid JSON value");
    return encoded;
}
export function resultDigest(result) {
    const wire = JSON.parse(JSON.stringify(result));
    return createHash("sha256").update(canonical(wire), "utf8").digest("hex");
}
export const validSubmissionId = (s) => typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export const validDigest = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
