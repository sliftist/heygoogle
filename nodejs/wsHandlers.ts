import {
    ensureAccount,
    getAdditionalPrompt,
    getCurrentDailyCost,
    isSuperuser,
    listGoogleLinks,
    listSuGoogleRequests,
    listSuLlmResponses,
    listSuToolCalls,
    LLM_DAILY_COST_CAP_USD,
    removeGoogleLink,
    setAdditionalPrompt,
    touchAccount,
} from "./accounts";
import { MAX_ADDITIONAL_PROMPT_LEN, SEND_TO_DEVICE_DEFAULT_TIMEOUT_MS } from "./config";
import { db, todayYMD } from "./db";
import { pubkeyFingerprint } from "./fingerprint";
import { assignShortIds, buildSystemPrompt } from "./llm";
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
    updateDeviceCapabilities,
    updateDeviceDescription,
} from "./devices";
import { buildDevicesForLLM, runLLMWithDeviceTools } from "./llm";

function devicesForLLMContext(accountPubkey: string, registry: WsRegistry) {
    return buildDevicesForLLM({ accountPubkey, isConnected: registry.isConnected });
}

function listDevicesShape(accountPubkey: string, registry: WsRegistry) {
    const devices = listDevicesForAccount(accountPubkey);
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
}

function listGoogleLinksShape(accountPubkey: string) {
    return { links: listGoogleLinks(accountPubkey) };
}

function listAccountsShape(devicePubkey: string) {
    return { accounts: listAccountsForDevice(devicePubkey) };
}

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
        "list-devices": () => listDevicesShape(ctx.pubkey, registry),
        "unregister-device": () => {
            const devicePubkey = String(data.device_pubkey || "");
            if (!devicePubkey) throw new Error("Missing device_pubkey");
            const result = removeDeviceFromAccount({ accountPubkey: ctx.pubkey, devicePubkey });
            return { ...result, ...listDevicesShape(ctx.pubkey, registry) };
        },
        "update-device-description": () => {
            const devicePubkey = String(data.device_pubkey || "");
            const description = String(data.description || "");
            if (!devicePubkey) throw new Error("Missing device_pubkey");
            if (!description) throw new Error("Missing description");
            const result = updateDeviceDescription({ accountPubkey: ctx.pubkey, devicePubkey, description });
            if (!result.updated) throw new Error("Device not found on this account");
            return { ...result, ...listDevicesShape(ctx.pubkey, registry) };
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
            return { ok: true, ...listDevicesShape(ctx.pubkey, registry) };
        },
        "list-google-links": () => listGoogleLinksShape(ctx.pubkey),
        "unregister-google-link": () => {
            const googleUserId = String(data.google_user_id || "");
            if (!googleUserId) throw new Error("Missing google_user_id");
            const result = removeGoogleLink({ pubkey: ctx.pubkey, googleUserId });
            return { ...result, ...listGoogleLinksShape(ctx.pubkey) };
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
            const devicesForLLM = devicesForLLMContext(ctx.pubkey, registry);
            return runLLMWithDeviceTools({
                accountPubkey: ctx.pubkey,
                prompt,
                devices: devicesForLLM,
                additionalPrompt: getAdditionalPrompt(ctx.pubkey),
                sendToDevice: ({ devicePubkey, payload }) => registry.sendToDevice({ devicePubkey, payload }),
            });
        },
        "get-prompts": () => {
            const devicesForLLM = devicesForLLMContext(ctx.pubkey, registry);
            const assigned = assignShortIds(devicesForLLM);
            const additionalPrompt = getAdditionalPrompt(ctx.pubkey);
            return {
                systemPrompt: buildSystemPrompt({ assigned, additionalPrompt }),
                additionalPrompt,
                maxAdditionalPromptLen: MAX_ADDITIONAL_PROMPT_LEN,
            };
        },
        "set-additional-prompt": () => {
            if (typeof data.text !== "string") throw new Error("Missing text (must be a string; pass '' to clear)");
            setAdditionalPrompt({ pubkey: ctx.pubkey, text: data.text });
            return { ok: true };
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
            const googleEntries = listSuGoogleRequests(ctx.pubkey, limit).map(r => {
                let body: unknown;
                try { body = JSON.parse(r.raw_body); } catch { body = r.raw_body; }
                return { received_at: r.received_at, intent: r.intent, body };
            });
            const llmEntries = listSuLlmResponses(ctx.pubkey, limit).map(r => {
                let response: unknown;
                try { response = JSON.parse(r.response_json); } catch { response = r.response_json; }
                return {
                    received_at: r.received_at,
                    intent: "LLM_RESPONSE",
                    body: { iter: r.iter, costUsd: r.cost_usd, response },
                };
            });
            const toolEntries = listSuToolCalls(ctx.pubkey, limit).map(r => {
                let sentPayload: unknown;
                try { sentPayload = JSON.parse(r.sent_payload_json); } catch { sentPayload = r.sent_payload_json; }
                let result: unknown;
                if (r.result_json !== null) {
                    try { result = JSON.parse(r.result_json); } catch { result = r.result_json; }
                }
                return {
                    received_at: r.received_at,
                    intent: "TOOL_CALL",
                    body: {
                        toolName: r.tool_name,
                        devicePubkey: r.device_pubkey,
                        argumentsRaw: r.arguments_raw,
                        sentPayload,
                        result,
                        error: r.error_message,
                    },
                };
            });
            const combined = [...googleEntries, ...llmEntries, ...toolEntries]
                .sort((a, b) => b.received_at - a.received_at)
                .slice(0, limit);
            return { requests: combined };
        },
        "total-daily-cost": () => {
            if (!isSuperuser(ctx.pubkey)) throw new Error("This packet requires superuser");
            const today = todayYMD();
            const row = db.prepare(`
                SELECT COALESCE(SUM(daily_cost_usd), 0) AS total, COUNT(*) AS users
                FROM accounts WHERE daily_cost_date = ?
            `).get(today) as { total: number; users: number };
            return {
                totalUsd: row.total,
                accountsContributing: row.users,
                date: today,
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
        "list-accounts": () => listAccountsShape(ctx.pubkey),
        "unregister-account": () => {
            const accountPubkey = String(data.account_pubkey || "");
            if (!accountPubkey) throw new Error("Missing account_pubkey");
            const result = removeAccountFromDevice({ devicePubkey: ctx.pubkey, accountPubkey });
            return { ...result, ...listAccountsShape(ctx.pubkey) };
        },
        "update-capabilities": () => {
            if (data.capabilities === undefined) throw new Error("Missing capabilities");
            const result = updateDeviceCapabilities({ devicePubkey: ctx.pubkey, capabilities: data.capabilities });
            if (result.updatedRows === 0) throw new Error("Device not registered with any account");
            return { ok: true, accountsUpdated: result.updatedRows };
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
