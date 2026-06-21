import crypto from "crypto";
import { b64decode } from "./crypto";
import { bytesToWords } from "./words";

// Word phrase fingerprint for a base64-SPKI public key. We hash the key
// (SHA-256) before mapping to words so phrases differ across the whole
// length — raw SPKI shares a fixed DER prefix across every P-256 key and
// would yield phrases that all start the same.
export function pubkeyFingerprint(pubkeyB64: string): string {
    const digest = crypto.createHash("sha256").update(b64decode(pubkeyB64)).digest();
    return bytesToWords(new Uint8Array(digest)).join(" ");
}
