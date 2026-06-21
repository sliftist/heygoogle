import { webcrypto } from "crypto";

const subtle = webcrypto.subtle;
type CryptoKey = Awaited<ReturnType<typeof subtle.importKey>>;

export function b64encode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

export function b64decode(s: string): Uint8Array {
    return new Uint8Array(Buffer.from(s, "base64"));
}

export function canonicalJSON(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalJSON).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
        if (obj[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
    }
    return "{" + parts.join(",") + "}";
}

const keyCache = new Map<string, CryptoKey>();

async function importEcdsaPublicKey(spkiB64: string): Promise<CryptoKey> {
    const cached = keyCache.get(spkiB64);
    if (cached) return cached;
    const spki = b64decode(spkiB64);
    const key = await subtle.importKey(
        "spki",
        spki,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
    );
    if (keyCache.size > 5000) keyCache.clear();
    keyCache.set(spkiB64, key);
    return key;
}

export async function verifySignature(config: {
    pubkeyB64: string;
    signatureB64: string;
    bytes: Uint8Array;
}): Promise<boolean> {
    const key = await importEcdsaPublicKey(config.pubkeyB64);
    const sig = b64decode(config.signatureB64);
    if (sig.byteLength !== 64) {
        throw new Error(`Expected 64-byte P1363 signature, was ${sig.byteLength}`);
    }
    return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, config.bytes);
}

export async function validateSpkiPubkey(pubkeyB64: string): Promise<void> {
    await importEcdsaPublicKey(pubkeyB64);
}
