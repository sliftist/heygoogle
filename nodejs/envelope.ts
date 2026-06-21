import { canonicalJSON, verifySignature } from "./crypto";
import { ENVELOPE_TIMESTAMP_WINDOW_MS } from "./config";

export type Secured = {
    type: string;
    id: string;
    nonce: string;
    timestamp: number;
    data?: unknown;
};

export type Envelope = {
    secured: Secured;
    signature: string;
    pubkey: string;
};

export type VerifiedEnvelope = {
    pubkey: string;
    secured: Secured;
};

export async function parseSignedEnvelope(raw: string, options?: { maxAgeMs?: number }): Promise<VerifiedEnvelope> {
    const window = options && options.maxAgeMs !== undefined ? options.maxAgeMs : ENVELOPE_TIMESTAMP_WINDOW_MS;

    const env = JSON.parse(raw) as Envelope;
    if (!env || typeof env !== "object") throw new Error("Envelope must be an object");
    if (!env.secured || typeof env.secured !== "object") throw new Error("Envelope missing secured object");
    if (typeof env.signature !== "string") throw new Error("Envelope missing signature");
    if (typeof env.pubkey !== "string") throw new Error("Envelope missing pubkey");

    const s = env.secured;
    if (typeof s.type !== "string") throw new Error("secured.type must be string");
    if (typeof s.id !== "string") throw new Error("secured.id must be string");
    if (typeof s.nonce !== "string") throw new Error("secured.nonce must be string");
    if (typeof s.timestamp !== "number") throw new Error("secured.timestamp must be number");

    const drift = Math.abs(Date.now() - s.timestamp);
    if (drift > window) {
        throw new Error(`Envelope timestamp drift ${drift}ms exceeds window ${window}ms`);
    }

    const bytes = Buffer.from(canonicalJSON(s), "utf8");
    const ok = await verifySignature({
        pubkeyB64: env.pubkey,
        signatureB64: env.signature,
        bytes: new Uint8Array(bytes),
    });
    if (!ok) throw new Error("Envelope signature verification failed");

    return { pubkey: env.pubkey, secured: s };
}
