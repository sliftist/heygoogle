import http from "http";
import { isSuperuser, recordGoogleRequest } from "./accounts";
import { authenticateBearer, invalidateGoogleLink } from "./oauth";
import { log } from "./log";
import { getExecuteAckState, getQueryState } from "./queryHandlers";
import { Device, loadDevices } from "./storage";

type Intent = {
    intent: string;
    payload?: Record<string, unknown>;
};

type FulfillmentRequest = {
    requestId: string;
    inputs: Intent[];
};

type ExecuteCommand = {
    devices: { id: string }[];
    execution: {
        command: string;
        params?: Record<string, unknown>;
    }[];
};

type ExecutePayload = {
    commands: ExecuteCommand[];
};

function sendJSON(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function deviceForSync(device: Device) {
    return {
        id: device.id,
        type: device.type,
        traits: device.traits,
        name: device.name,
        willReportState: device.willReportState,
        roomHint: device.roomHint,
        attributes: device.attributes,
    };
}

function handleSync(userId: string, requestId: string) {
    const devices = loadDevices();
    return {
        requestId,
        payload: {
            agentUserId: userId,
            devices: devices.map(deviceForSync),
        },
    };
}

function handleQuery(userId: string, requestId: string, payload: Record<string, unknown>) {
    const devicesIn = (payload.devices as { id: string }[]) || [];
    const out: Record<string, unknown> = {};
    for (const d of devicesIn) {
        out[d.id] = getQueryState({ userId, deviceId: d.id });
    }
    return {
        requestId,
        payload: { devices: out },
    };
}

function handleExecute(requestId: string, payload: ExecutePayload) {
    const ids: string[] = [];
    for (const cmd of payload.commands || []) {
        for (const d of cmd.devices) ids.push(d.id);
    }
    return {
        requestId,
        payload: {
            commands: [
                {
                    ids,
                    status: "SUCCESS",
                    states: getExecuteAckState(),
                },
            ],
        },
    };
}

function handleDisconnect(requestId: string, googleUserId: string) {
    invalidateGoogleLink(googleUserId);
    return { requestId, payload: {} };
}

export async function handleFulfillment(req: http.IncomingMessage, res: http.ServerResponse) {
    const identity = authenticateBearer(req);
    if (!identity) {
        sendJSON(res, 401, { error: "unauthorized" });
        return;
    }
    const userId = identity.pubkey;
    const raw = await readBody(req);
    const body = JSON.parse(raw) as FulfillmentRequest;

    const requestId = body.requestId || "";
    const input = body.inputs && body.inputs[0];
    const intent = input && input.intent || "";
    const payload = input && input.payload || {};

    const shortIntent = intent.replace(/^action\.devices\./, "");
    const userIsSuperuser = isSuperuser(userId);
    if (userIsSuperuser) {
        log("google", `[SU] ${shortIntent} user=${userId.slice(0, 16)}... requestId=${requestId}`, body);
        recordGoogleRequest({ accountPubkey: userId, intent, rawBody: raw });
    } else {
        log("google", `${shortIntent} user=${userId.slice(0, 16)}... requestId=${requestId} (payload redacted)`);
    }

    if (intent === "action.devices.SYNC") {
        sendJSON(res, 200, handleSync(userId, requestId));
        return;
    }
    if (intent === "action.devices.QUERY") {
        sendJSON(res, 200, handleQuery(userId, requestId, payload));
        return;
    }
    if (intent === "action.devices.EXECUTE") {
        sendJSON(res, 200, handleExecute(requestId, payload as ExecutePayload));
        return;
    }
    if (intent === "action.devices.DISCONNECT") {
        sendJSON(res, 200, handleDisconnect(requestId, identity.googleUserId));
        return;
    }

    log("google", `unknown intent=${intent} user=${userId.slice(0, 16)}...`);
    sendJSON(res, 400, { error: "unknown_intent", intent });
}
