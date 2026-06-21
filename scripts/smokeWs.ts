import { webcrypto } from "crypto";
import WebSocket from "ws";
import { canonicalJSON, b64encode } from "../nodejs/crypto";

const subtle = webcrypto.subtle;
type CryptoKey = Awaited<ReturnType<typeof subtle.importKey>>;
const WS_URL = "wss://heygoogle.vidgridweb.com:7951/control";

type Identity = {
    pubkeyB64: string;
    privateKey: CryptoKey;
};

async function generateIdentity(): Promise<Identity> {
    const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = await subtle.exportKey("spki", (kp as { publicKey: CryptoKey }).publicKey);
    return { pubkeyB64: b64encode(new Uint8Array(spki)), privateKey: (kp as { privateKey: CryptoKey }).privateKey };
}

async function signEnvelope(identity: Identity, secured: object): Promise<string> {
    const bytes = Buffer.from(canonicalJSON(secured), "utf8");
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, bytes);
    return JSON.stringify({
        secured,
        signature: b64encode(new Uint8Array(sig)),
        pubkey: identity.pubkeyB64,
    });
}

function makeSecured(type: string, data?: unknown): { type: string; id: string; nonce: string; timestamp: number; data?: unknown } {
    return {
        type,
        id: Math.random().toString(36).slice(2),
        nonce: Math.random().toString(36).slice(2),
        timestamp: Date.now(),
        data,
    };
}

type WaitingCall = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function openWs(identity: Identity, label: string, onDeviceCall?: (payload: unknown) => unknown): Promise<{
    ws: WebSocket;
    call: (type: string, data?: unknown) => Promise<unknown>;
    close: () => void;
}> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
        const waiters = new Map<string, WaitingCall>();

        ws.on("open", () => {
            console.log(`[${label}] connected`);
            resolve({ ws, call, close: () => ws.close() });
        });
        ws.on("error", err => {
            console.error(`[${label}] error`, err);
            reject(err);
        });
        ws.on("message", async (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "device-call" && onDeviceCall) {
                const payload = msg.payload;
                const result = await onDeviceCall(payload);
                const ret = await signEnvelope(identity, makeSecured("device-return", { response: result }));
                const env = JSON.parse(ret);
                env.secured.id = msg.id;
                env.signature = b64encode(new Uint8Array(await subtle.sign(
                    { name: "ECDSA", hash: "SHA-256" },
                    identity.privateKey,
                    Buffer.from(canonicalJSON(env.secured), "utf8"),
                )));
                ws.send(JSON.stringify(env));
                return;
            }
            if (msg.type === "return" || msg.type === "error") {
                const w = waiters.get(msg.id);
                if (w) {
                    waiters.delete(msg.id);
                    if (msg.type === "return") w.resolve(msg.data);
                    else w.reject(new Error(msg.error));
                }
            }
        });

        async function call(type: string, data?: unknown): Promise<unknown> {
            const secured = makeSecured(type, data);
            const env = await signEnvelope(identity, secured);
            return new Promise((res, rej) => {
                waiters.set(secured.id, { resolve: res, reject: rej });
                ws.send(env);
                setTimeout(() => {
                    if (waiters.has(secured.id)) {
                        waiters.delete(secured.id);
                        rej(new Error(`timeout for ${type}`));
                    }
                }, 20_000);
            });
        }
    });
}

async function main() {
    const account = await generateIdentity();
    const device = await generateIdentity();
    console.log("account pubkey", account.pubkeyB64.slice(0, 24) + "...");
    console.log("device pubkey ", device.pubkeyB64.slice(0, 24) + "...");

    const acct = await openWs(account, "account");
    console.log("ws-stats:", await acct.call("ws-stats"));

    console.log("list-devices (empty):", await acct.call("list-devices"));

    const otp = "123456";
    const dev = await openWs(device, "device", (payload) => {
        console.log("[device] received call:", payload);
        return { ack: true, echoed: payload };
    });
    console.log("register-device-pairing:", await dev.call("register-device-pairing", {
        otp,
        description: "Test pretend TV in the living room",
        capabilities: { actions: ["on", "off", "play"] },
    }));

    console.log("register-device-confirm:", await acct.call("register-device-confirm", {
        device_pubkey: device.pubkeyB64,
        otp,
    }));

    console.log("list-devices (one):", await acct.call("list-devices"));
    console.log("list-accounts (from device):", await dev.call("list-accounts"));

    console.log("send-to-device:", await acct.call("send-to-device", {
        device_pubkey: device.pubkeyB64,
        payload: { action: "play", title: "Avatar" },
    }));

    console.log("send to non-existent device should fail:");
    try {
        await acct.call("send-to-device", { device_pubkey: account.pubkeyB64, payload: {} });
        console.log("  (unexpected: no error)");
    } catch (err) {
        console.log("  expected error:", (err as Error).message);
    }

    console.log("daily-cost before LLM:", await acct.call("daily-cost"));

    console.log("calling llm-prompt — may incur cost...");
    try {
        const llmResult = await acct.call("llm-prompt", {
            prompt: "Turn on the test TV and tell me what happened.",
        });
        console.log("llm-prompt result:", llmResult);
    } catch (err) {
        console.log("llm-prompt error:", (err as Error).message);
    }

    console.log("daily-cost after LLM:", await acct.call("daily-cost"));

    console.log("unregister-device:", await acct.call("unregister-device", { device_pubkey: device.pubkeyB64 }));
    console.log("list-devices (should be empty):", await acct.call("list-devices"));

    acct.close();
    dev.close();
    setTimeout(() => process.exit(0), 500);
}

main().catch(err => { console.error(err); process.exit(1); });
