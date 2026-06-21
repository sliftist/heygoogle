# heygoogle protocol

This server brokers between:
- **browsers / accounts** — users identified by an ECDSA P-256 keypair stored client-side (IndexedDB).
- **devices** — things controlled (TVs, speakers, etc.), also keypair-identified.
- **Google Home** — links Google accounts to a user's pubkey via OAuth.
- **an LLM** — receives a prompt, generates tool calls that hit devices through the same WS pipeline.

All long-lived interaction happens over a signed-packet WebSocket. Google Home talks to the REST endpoints documented at the bottom.

## Identity

Every account and every device is **one ECDSA P-256 keypair**.

- Curve: `P-256`
- Public key wire format: base64 of the SPKI (`subtle.exportKey("spki", publicKey)`)
- Signature wire format: base64 of the raw P1363 64-byte signature (`subtle.sign({name:"ECDSA",hash:"SHA-256"}, privateKey, bytes)`)

The private key never leaves the device/browser. Pubkey is the stable identifier the server stores.

### Canonical JSON (for signing)

Recursively sort object keys; no whitespace; preserve array order; drop `undefined` fields. The reference implementation:

```ts
function canonicalJSON(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
        if (obj[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
    }
    return "{" + parts.join(",") + "}";
}
```

### Signed envelope

Every WebSocket message is one of these:

```json
{
  "secured": {
    "type": "<packet type>",
    "id":   "<caller-generated correlation id, string>",
    "nonce": "<random base64, ~16 bytes>",
    "timestamp": 1782060000000,
    "data": { /* type-specific */ }
  },
  "signature": "<base64 P1363 64-byte signature over canonicalJSON(secured)>",
  "pubkey":    "<base64 SPKI public key>"
}
```

The server rejects packets whose timestamp is more than 60s off `Date.now()`. There is no nonce cache yet — the timestamp window is the only replay protection.

Server responses to client packets are **not** signed (the TLS connection authenticates the server). They use this shape:

```json
{ "type": "return", "id": "<echoes request id>", "data": { ... } }
{ "type": "error",  "id": "<echoes request id>", "error": "<message>" }
```

## WebSocket endpoint

`wss://heygoogle.vidgridweb.com:7951/control`

Open a WebSocket. Send signed envelopes. The server identifies your connection by the pubkey on your **first** signed packet. Subsequent packets must use the same pubkey. Multiple WS connections per pubkey are allowed.

A connection's role (account vs device) is decided by table membership: if the pubkey is in the `devices` table, it's a device connection; otherwise it's treated as an account (and an account row is upserted on first packet).

## Packet types

All shapes below describe `secured.type` and `secured.data`. Response goes in `{type:"return", id, data}`.

### From an account (browser)

| `type` | `data` | response `data` |
|---|---|---|
| `ws-stats` | `{}` | `{ connectionsForThisAccount, lastConnectedAt, lastDisconnectedAt }` |
| `list-devices` | `{}` | `{ devices: [{ device_pubkey, description, capabilities, registered_at, last_active_at, connected }] }` |
| `unregister-device` | `{ device_pubkey }` | `{ removed: bool }` |
| `register-device-confirm` | `{ device_pubkey, otp }` | `{ ok: true }` (fails if OTP doesn't match or pairing expired/missing) |
| `list-google-links` | `{}` | `{ links: [{ google_user_id, linked_at }] }` |
| `unregister-google-link` | `{ google_user_id }` | `{ removed: bool }` |
| `bind-google-link` | `{ google_user_id }` | `{ ok: true }` — manually associate an existing google_user_id with this account |
| `send-to-device` | `{ device_pubkey, payload, timeoutMs? }` | `{ response }` — fails if device isn't connected to this server |
| `llm-prompt` | `{ prompt }` | `{ reply, toolCallsUsed, costUsd, dailyCostUsd }` — server invokes LLM with one tool per active + top-3-inactive devices, chains up to 10 tool calls, enforces $0.15/day cap |
| `daily-cost` | `{}` | `{ usd, capUsd, date, superuser }` — `usd` is today's spend, `capUsd` is the per-day cap, `date` is today's UTC YMD, `superuser` is the account flag |

### From a device

| `type` | `data` | response `data` |
|---|---|---|
| `register-device-pairing` | `{ otp, description, capabilities }` | `{ ok: true }` — creates a pending pairing keyed by this device's pubkey; expires after 10 min; an account then confirms with the same `(device_pubkey, otp)` |
| `list-accounts` | `{}` | `{ accounts: [{ account_pubkey, registered_at }] }` |
| `unregister-account` | `{ account_pubkey }` | `{ removed: bool }` |

### Server → device (unsolicited)

When an account does `send-to-device` (directly or via LLM), the server forwards an **unsigned** JSON frame to the device's WebSocket:

```json
{ "type": "device-call", "id": "<server-generated>", "payload": <whatever the account sent> }
```

The device must respond with a signed envelope:

```json
{
  "secured": {
    "type": "device-return",
    "id": "<echoes the device-call id>",
    "nonce": "...",
    "timestamp": ...,
    "data": { "response": <arbitrary> }   // or { "error": "<message>" }
  },
  "signature": "...",
  "pubkey": "..."
}
```

Default call timeout: 10s. Account can override via `timeoutMs`.

## Errors

Error responses are `{ type: "error", id, error }` where `error` is a human-readable string. Common cases:

| Error | Cause |
|---|---|
| `Envelope timestamp drift ...ms exceeds window 60000ms` | Clock skew or replay attempt |
| `Envelope signature verification failed` | Wrong key or tampered packet |
| `Type X requires an account, but this pubkey is registered as a device` | Sent an account-only packet from a device pubkey |
| `Type X requires a registered device` | Sent a device-only packet from a pubkey that isn't in `devices` |
| `Target device is not currently connected` | `send-to-device` for an offline device |
| `device call timed out after ...ms` | Device didn't return within `timeoutMs` |
| `Daily LLM cost cap reached: $X >= $0.15` | Account hit the daily cap |

## OAuth (Google Home) flow

Three URLs:

- **`GET /oauth/authorize`** — Google opens this. We validate `client_id` + `redirect_uri` (must be on the Google allowlist) then 302-redirect to the **external** authorize page (`https://vidgridweb.com?page=heygoogle`) with all query params preserved.
- **`POST /oauth/token`** — Google exchanges `code` here. The code is the user's **base64 SPKI pubkey**; we validate it parses as P-256 and mint an access+refresh token tied to that pubkey + a synthetic `google_user_id`. Refresh-token grant works the standard way.
- **`POST /smarthome/fulfillment`** — Google calls this for SYNC/QUERY/EXECUTE/DISCONNECT. Bearer token resolves to `{ pubkey, googleUserId }`. DISCONNECT invalidates only the affected `google_user_id`, never the account.

### External page contract

The external page at `https://vidgridweb.com?page=heygoogle` receives the query string `?client_id=...&redirect_uri=...&response_type=code&state=...`. It must:

1. Generate or load (from IndexedDB) the user's P-256 keypair.
2. Export the public key as base64 SPKI.
3. Redirect the browser to `<redirect_uri>?code=<base64-spki-pubkey>&state=<state>`.

That's it. No backend call to us. The pubkey-as-code piggybacks the standard OAuth flow.

The external page can also (optionally) call `wss://heygoogle.vidgridweb.com:7951/control` directly with the same keypair to perform any account operation (list Google links, list devices, send LLM prompts, etc.) — same identity, no separate login.

## Implementing a device

```ts
// boot
const kp = await loadOrGenerateP256();
const pubkeyB64 = b64(await subtle.exportKey("spki", kp.publicKey));

// pair (one time)
const otp = "<show on screen>";
await ws.send(signedEnvelope({
    type: "register-device-pairing",
    data: { otp, description: "Living room TV", capabilities: { ... } }
}));
// user enters OTP + device_pubkey in their browser, calls register-device-confirm

// service loop
ws.onmessage = async raw => {
    const msg = JSON.parse(raw);
    if (msg.type === "device-call") {
        const result = await handleCall(msg.payload);  // your code
        await ws.send(signedEnvelope({
            type: "device-return",
            id: msg.id,
            data: { response: result }
        }));
    }
};
```

Reconnect on disconnect; identity stays stable across reconnects.

## Implementing a client (browser)

```ts
const kp = await loadOrGenerateP256();
const ws = new WebSocket("wss://heygoogle.vidgridweb.com:7951/control");

// helper
async function call(type, data) {
    const id = randomId();
    const secured = { type, id, nonce: randomB64(16), timestamp: Date.now(), data };
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" },
                                   kp.privateKey,
                                   utf8(canonicalJSON(secured)));
    ws.send(JSON.stringify({ secured,
                             signature: b64(sig),
                             pubkey: b64(await subtle.exportKey("spki", kp.publicKey)) }));
    return waitForReturn(id);
}

await call("ws-stats");
await call("list-devices");
await call("llm-prompt", { prompt: "play Avatar on the TV" });
```

For Google Home linking, also implement the external authorize page contract above.

## Superuser flag

Accounts have a `superuser` boolean column. There is no API to grant it remotely — it's set only via a CLI script on the server:

```
typenode scripts/setSuperuser.ts grant <base64-spki-pubkey>
typenode scripts/setSuperuser.ts revoke <base64-spki-pubkey>
```

The value is surfaced to the client through the `daily-cost` packet's `superuser` field. The server does not currently enforce any superuser-only behavior — it's a marker for future privileged operations.

## Limits & caps

- Max 100 stored IPs per account (oldest dropped on overflow)
- Pending pairings expire 10 min after creation
- Envelope timestamp drift window: ±60s
- send-to-device default timeout: 10s
- LLM iterations per prompt: 10
- LLM daily cost cap per account: $0.15 USD
- LLM context includes all currently-connected devices + the 3 most-recently-active disconnected devices
- Model: `google/gemini-3.1-flash-lite` (configurable in `nodejs/config.ts`)

## Storage layout

All persistent state lives in **one SQLite file**: `~/heygoogle-data/heygoogle.sqlite`. No DB process — the server opens it directly via better-sqlite3. Tables: `accounts`, `account_ips`, `google_links`, `devices`, `pending_pairings`, `oauth_tokens`. Inspect with `sqlite3 ~/heygoogle-data/heygoogle.sqlite ".schema"`.

Other files in `~/heygoogle-data/`:
- `clientSecret.json` — OAuth client id/secret for the Smart Home action
- `tls/origin.crt` + `tls/origin.key` — Let's Encrypt cert
- `tls/letsencrypt-account.key` — ACME account key
- `server.log` — single consolidated log
- `server.pid` — running pid
