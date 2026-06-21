import https from "https";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { WS_PATH } from "./config";
import { log, logErr } from "./log";
import { parseSignedEnvelope } from "./envelope";
import { isDevice, touchDeviceActive } from "./devices";
import { canonicalJSON } from "./crypto";
import { dispatch, ConnectionContext, WsRegistry } from "./wsHandlers";

type ConnectionState = {
    ws: WebSocket;
    pubkey: string;
    isDeviceConnection: boolean;
    ip: string;
    pendingDeviceCalls: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
};

const byPubkey = new Map<string, Set<ConnectionState>>();
const byWs = new WeakMap<WebSocket, ConnectionState>();
const connectionStats = new Map<string, { lastConnectedAt: number; lastDisconnectedAt: number }>();

function addConnection(state: ConnectionState) {
    let set = byPubkey.get(state.pubkey);
    if (!set) {
        set = new Set();
        byPubkey.set(state.pubkey, set);
    }
    set.add(state);
    byWs.set(state.ws, state);
    const prev = connectionStats.get(state.pubkey) || { lastConnectedAt: 0, lastDisconnectedAt: 0 };
    connectionStats.set(state.pubkey, { ...prev, lastConnectedAt: Date.now() });
}

function removeConnection(state: ConnectionState) {
    const set = byPubkey.get(state.pubkey);
    if (set) {
        set.delete(state);
        if (set.size === 0) byPubkey.delete(state.pubkey);
    }
    const prev = connectionStats.get(state.pubkey) || { lastConnectedAt: 0, lastDisconnectedAt: 0 };
    connectionStats.set(state.pubkey, { ...prev, lastDisconnectedAt: Date.now() });
    for (const pending of state.pendingDeviceCalls.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("device disconnected"));
    }
    state.pendingDeviceCalls.clear();
}

function pickDeviceConnection(devicePubkey: string): ConnectionState | undefined {
    const set = byPubkey.get(devicePubkey);
    if (!set || set.size === 0) return undefined;
    return set.values().next().value;
}

const registry: WsRegistry = {
    isConnected: (pubkey: string) => byPubkey.has(pubkey),
    sendToDevice: ({ devicePubkey, payload, timeoutMs }) => {
        const conn = pickDeviceConnection(devicePubkey);
        if (!conn) return Promise.reject(new Error("device not connected"));
        const id = crypto.randomBytes(8).toString("hex");
        const effectiveTimeout = timeoutMs || 10_000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pendingDeviceCalls.delete(id);
                reject(new Error(`device call timed out after ${effectiveTimeout}ms`));
            }, effectiveTimeout);
            conn.pendingDeviceCalls.set(id, { resolve, reject, timer });
            conn.ws.send(JSON.stringify({ type: "device-call", id, payload }));
        });
    },
    connectionsForPubkey: (pubkey: string) => byPubkey.get(pubkey)?.size || 0,
    statsForPubkey: (pubkey: string) => connectionStats.get(pubkey) || { lastConnectedAt: 0, lastDisconnectedAt: 0 },
};

function sendEnvelope(ws: WebSocket, envelope: unknown) {
    ws.send(canonicalJSON(envelope));
}

function reply(ws: WebSocket, id: string, result: unknown) {
    sendEnvelope(ws, { type: "return", id, data: result });
}

function replyError(ws: WebSocket, id: string, error: string) {
    sendEnvelope(ws, { type: "error", id, error });
}

async function handleMessage(ws: WebSocket, raw: string) {
    let secured;
    let pubkey;
    try {
        const env = await parseSignedEnvelope(raw);
        secured = env.secured;
        pubkey = env.pubkey;
    } catch (err) {
        log("ws", `envelope rejected: ${(err as Error).message || err}`);
        return;
    }

    const id = secured.id;

    if (secured.type === "device-return") {
        const existingState = byWs.get(ws);
        if (!existingState) {
            replyError(ws, id, "connection not yet registered");
            return;
        }
        const pending = existingState.pendingDeviceCalls.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        existingState.pendingDeviceCalls.delete(id);
        const data = (secured.data || {}) as { response?: unknown; error?: string };
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.response);
        return;
    }

    let state = byWs.get(ws);
    if (!state) {
        const isDev = isDevice(pubkey);
        state = {
            ws,
            pubkey,
            isDeviceConnection: isDev,
            ip: (ws as unknown as { _ip?: string })._ip || "",
            pendingDeviceCalls: new Map(),
        };
        addConnection(state);
        if (isDev) touchDeviceActive(pubkey);
        log("ws", `connection registered pubkey=${pubkey.slice(0, 16)}... isDevice=${isDev}`);
    } else if (state.pubkey !== pubkey) {
        replyError(ws, id, "pubkey changed mid-connection");
        return;
    }

    const ctx: ConnectionContext = {
        pubkey: state.pubkey,
        ip: state.ip,
        isDeviceConnection: state.isDeviceConnection,
        sendUnsolicited: (envelope) => sendEnvelope(ws, envelope),
    };

    try {
        const result = await dispatch({ secured, ctx, registry });
        reply(ws, id, result);
    } catch (err) {
        replyError(ws, id, (err as Error).message || String(err));
    }
}

export function attachWebSocketServer(server: https.Server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: http.IncomingMessage, socket, head) => {
        const url = new URL(req.url || "/", "https://localhost");
        if (url.pathname !== WS_PATH) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
            (ws as unknown as { _ip?: string })._ip = ip;
            log("ws", `upgrade accepted ip=${ip}`);

            ws.on("message", (data) => {
                const raw = typeof data === "string" ? data : data.toString();
                handleMessage(ws, raw).catch(err => logErr("ws", "message handler crashed", err));
            });

            ws.on("close", () => {
                const state = byWs.get(ws);
                if (state) {
                    removeConnection(state);
                    log("ws", `connection closed pubkey=${state.pubkey.slice(0, 16)}...`);
                }
            });

            ws.on("error", err => {
                logErr("ws", "socket error", err);
            });
        });
    });

    log("ws", `WebSocket server attached at ${WS_PATH}`);
}
