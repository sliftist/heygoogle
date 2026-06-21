import {
    addGoogleLink,
    ensureAccount,
    getCurrentDailyCost,
    isSuperuser,
    listGoogleLinks,
    listSuGoogleRequests,
    LLM_DAILY_COST_CAP_USD,
    removeGoogleLink,
    touchAccount,
} from "./accounts";
import { LLM_INACTIVE_DEVICES_IN_CONTEXT, SEND_TO_DEVICE_DEFAULT_TIMEOUT_MS } from "./config";
import { todayYMD } from "./db";
import { pubkeyFingerprint } from "./fingerprint";
import {
    consumePendingPairing,
    isDevice,
    listAccountsForDevice,
    listDevicesForAccount,
    registerDeviceForAccount,
    removeAccountFromDevice,
    removeDeviceFromAccount,
    setPendingPairing,
    touchDeviceActive,
    updateDeviceDescription,
} from "./devices";
import { runLLMWithDeviceTools, DeviceForLLM } from "./llm";

export type Secured = {
    type: string;
    id: string;
    nonce: string;
    timestamp: number;
    data?: unknown;
};

export type ConnectionContext = {
    pubkey: string;
    ip: string;
    isDeviceConnection: boolean;
    sendUnsolicited: (envelope: unknown) => void;
};

export type WsRegistry = {
    isConnected: (pubkey: string) => boolean;
    sendToDevice: (config: { devicePubkey: string; payload: unknown; timeoutMs?: number }) => Promise<unknown>;
    connectionsForPubkey: (pubkey: string) => number;
    statsForPubkey: (pubkey: string) => { lastConnectedAt: number; lastDisconnectedAt: number };
};

export async function dispatch(config: {
    secured: Secured;
    ctx: ConnectionContext;
    registry: WsRegistry;
}): Promise<unknown> {
    const { secured, ctx, registry } = config;
    const data = (secured.data || {}) as Record<string, unknown>;
    const t = secured.type;

    const accountOps: Record<string, () => Promise<unknown> | unknown> = {
        "ws-stats": () => {
            const stats = registry.statsForPubkey(ctx.pubkey);
            return {
                connectionsForThisAccount: registry.connectionsForPubkey(ctx.pubkey),
                lastConnectedAt: stats.lastConnectedAt,
                lastDisconnectedAt: stats.lastDisconnectedAt,
            };
        },
        "list-devices": () => {
            const devices = listDevicesForAccount(ctx.pubkey);
            return {
                devices: devices.map(d => ({
                    device_pubkey: d.device_pubkey,
                    description: d.description,
                    capabilities: JSON.parse(d.capabilities_json),
                    registered_at: d.registered_at,
                    last_active_at: d.last_active_at,
                    connected: registry.isConnected(d.device_pubkey),
                })),
            };
        },
        "unregister-device": () => {
            const devicePubkey = String(data.device_pubkey || "");
            if (!devicePubkey) throw new Error("Missing device_pubkey");
            return removeDeviceFromAccount({ accountPubkey: ctx.pubkey, devicePubkey });
        },
        "update-device-description": () => {
            const devicePubkey = String(data.device_pubkey || "");
            const description = String(data.description || "");
            if (!devicePubkey) throw new Error("Missing device_pubkey");
            if (!description) throw new Error("Missing description");
            const result = updateDeviceDescription({ accountPubkey: ctx.pubkey, devicePubkey, description });
            if (!result.updated) throw new Error("Device not found on this account");
            return result;
        },
        "register-device-confirm": () => {
            const devicePubkey = String(data.device_pubkey || "");
            const otp = String(data.otp || "");
            if (!devicePubkey || !otp) throw new Error("Missing device_pubkey or otp");
            const pending = consumePendingPairing(devicePubkey, otp);
            if (!pending) throw new Error("No matching pending pairing (wrong device_pubkey or otp, or expired)");
            registerDeviceForAccount({
                devicePubkey,
                accountPubkey: ctx.pubkey,
                description: pending.description,
                capabilities: JSON.parse(pending.capabilities_json),
            });
            return { ok: true };
        },
        "list-google-links": () => ({ links: listGoogleLinks(ctx.pubkey) }),
        "unregister-google-link": () => {
            const googleUserId = String(data.google_user_id || "");
            if (!googleUserId) throw new Error("Missing google_user_id");
            return removeGoogleLink({ pubkey: ctx.pubkey, googleUserId });
        },
        "bind-google-link": () => {
            const googleUserId = String(data.google_user_id || "");
            if (!googleUserId) throw new Error("Missing google_user_id");
            addGoogleLink({ googleUserId, pubkey: ctx.pubkey });
            return { ok: true };
        },
        "send-to-device": async () => {
            const devicePubkey = String(data.device_pubkey || "");
            if (!devicePubkey) throw new Error("Missing device_pubkey");
            const owned = listDevicesForAccount(ctx.pubkey).some(d => d.device_pubkey === devicePubkey);
            if (!owned) throw new Error(`Device ${devicePubkey.slice(0, 16)}... is not registered to this account`);
            if (!registry.isConnected(devicePubkey)) throw new Error("Target device is not currently connected");
            const timeoutMs = typeof data.timeoutMs === "number" ? data.timeoutMs : SEND_TO_DEVICE_DEFAULT_TIMEOUT_MS;
            const response = await registry.sendToDevice({ devicePubkey, payload: data.payload, timeoutMs });
            return { response };
        },
        "llm-prompt": async () => {
            const prompt = String(data.prompt || "");
            if (!prompt) throw new Error("Missing prompt");
            const all = listDevicesForAccount(ctx.pubkey);
            const active = all.filter(d => registry.isConnected(d.device_pubkey));
            const inactive = all.filter(d => !registry.isConnected(d.device_pubkey))
                .sort((a, b) => b.last_active_at - a.last_active_at)
                .slice(0, LLM_INACTIVE_DEVICES_IN_CONTEXT);
            const devicesForLLM: DeviceForLLM[] = [...active, ...inactive].map(d => ({
                devicePubkey: d.device_pubkey,
                description: d.description,
                capabilities: JSON.parse(d.capabilities_json),
                connected: registry.isConnected(d.device_pubkey),
                lastActiveAt: d.last_active_at,
            }));
            return runLLMWithDeviceTools({
                accountPubkey: ctx.pubkey,
                prompt,
                devices: devicesForLLM,
                sendToDevice: ({ devicePubkey, payload }) => registry.sendToDevice({ devicePubkey, payload }),
            });
        },
        "daily-cost": () => ({
            usd: getCurrentDailyCost(ctx.pubkey),
            capUsd: LLM_DAILY_COST_CAP_USD,
            date: todayYMD(),
            superuser: isSuperuser(ctx.pubkey),
        }),
        "whoami": () => ({
            pubkey: ctx.pubkey,
            superuser: isSuperuser(ctx.pubkey),
            fingerprint: pubkeyFingerprint(ctx.pubkey),
        }),
        "list-google-requests": () => {
            if (!isSuperuser(ctx.pubkey)) throw new Error("This packet requires superuser");
            const limit = typeof data.limit === "number" ? Math.min(Math.max(data.limit, 1), 100) : 100;
            const rows = listSuGoogleRequests(ctx.pubkey, limit);
            return {
                requests: rows.map(r => {
                    let body: unknown;
                    try { body = JSON.parse(r.raw_body); } catch { body = r.raw_body; }
                    return { received_at: r.received_at, intent: r.intent, body };
                }),
            };
        },
    };

    const deviceOps: Record<string, () => Promise<unknown> | unknown> = {
        "register-device-pairing": () => {
            const otp = String(data.otp || "");
            const description = String(data.description || "");
            const capabilities = data.capabilities;
            if (!otp) throw new Error("Missing otp");
            if (!description) throw new Error("Missing description");
            if (capabilities === undefined) throw new Error("Missing capabilities");
            setPendingPairing({ devicePubkey: ctx.pubkey, otp, description, capabilities });
            return { ok: true };
        },
        "list-accounts": () => ({ accounts: listAccountsForDevice(ctx.pubkey) }),
        "unregister-account": () => {
            const accountPubkey = String(data.account_pubkey || "");
            if (!accountPubkey) throw new Error("Missing account_pubkey");
            return removeAccountFromDevice({ devicePubkey: ctx.pubkey, accountPubkey });
        },
    };

    if (t in accountOps) {
        if (ctx.isDeviceConnection) throw new Error(`Type ${t} requires an account, but this pubkey is registered as a device`);
        touchAccount({ pubkey: ctx.pubkey, ip: ctx.ip });
        ensureAccount(ctx.pubkey);
        return await accountOps[t]();
    }

    if (t in deviceOps) {
        if (t === "register-device-pairing") {
            return await deviceOps[t]();
        }
        if (!isDevice(ctx.pubkey)) throw new Error(`Type ${t} requires a registered device`);
        touchDeviceActive(ctx.pubkey);
        return await deviceOps[t]();
    }

    throw new Error(`Unknown packet type: ${t}`);
}
