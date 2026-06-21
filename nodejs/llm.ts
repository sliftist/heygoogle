import fs from "fs";
import {
    LLM_DAILY_COST_CAP_USD,
    LLM_INACTIVE_DEVICES_IN_CONTEXT,
    LLM_MAX_TOOL_ITERATIONS,
    LLM_MODEL,
    OPENROUTER_KEY_PATH,
} from "./config";
import { addToDailyCost, assertDailyCostBelowCap, getCurrentDailyCost, isSuperuser, recordLlmResponse, recordToolCall } from "./accounts";
import { listDevicesForAccount } from "./devices";
import { log } from "./log";

type ToolDef = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required: string[];
        };
    };
};

type ChatMessage =
    | { role: "system" | "user" | "assistant"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
    | { role: "tool"; tool_call_id: string; content: string };

type OpenRouterResponse = {
    choices: {
        message: {
            role: "assistant";
            content: string | null;
            tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
        };
        finish_reason: string;
    }[];
    usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
    error?: { message: string };
};

export type DeviceForLLM = {
    devicePubkey: string;
    description: string;
    capabilities: unknown;
    connected: boolean;
    lastActiveAt: number;
};

export function buildDevicesForLLM(config: {
    accountPubkey: string;
    isConnected: (devicePubkey: string) => boolean;
}): DeviceForLLM[] {
    const all = listDevicesForAccount(config.accountPubkey);
    const active = all.filter(d => config.isConnected(d.device_pubkey));
    const inactive = all.filter(d => !config.isConnected(d.device_pubkey))
        .sort((a, b) => b.last_active_at - a.last_active_at)
        .slice(0, LLM_INACTIVE_DEVICES_IN_CONTEXT);
    return [...active, ...inactive].map(d => ({
        devicePubkey: d.device_pubkey,
        description: d.description,
        capabilities: JSON.parse(d.capabilities_json),
        connected: config.isConnected(d.device_pubkey),
        lastActiveAt: d.last_active_at,
    }));
}

let cachedKey: string | undefined;
function loadOpenRouterKey(): string {
    if (cachedKey) return cachedKey;
    const raw = fs.readFileSync(OPENROUTER_KEY_PATH, "utf8").trim();
    if (raw.startsWith("{")) {
        const obj = JSON.parse(raw) as { key?: string };
        if (!obj.key) throw new Error(`Expected {key:"..."} in ${OPENROUTER_KEY_PATH}`);
        cachedKey = obj.key;
        return cachedKey;
    }
    cachedKey = raw;
    return cachedKey;
}

function shortIdFor(index: number): string {
    return `dev${index + 1}`;
}

export type DeviceTool = {
    shortId: string;
    device: DeviceForLLM;
};

export function assignShortIds(devices: DeviceForLLM[]): DeviceTool[] {
    return devices.map((device, i) => ({ shortId: shortIdFor(i), device }));
}

function buildTools(assigned: DeviceTool[]): ToolDef[] {
    return assigned.map(({ shortId, device }) => {
        const status = device.connected ? "CONNECTED" : "OFFLINE";
        const caps = JSON.stringify(device.capabilities);
        return {
            type: "function" as const,
            function: {
                name: shortId,
                description: `[${status}] ${device.description}. Capabilities: ${caps}. Pass a JSON payload appropriate for this device. Refer to this device as ${shortId} in your replies.`,
                parameters: {
                    type: "object" as const,
                    properties: {
                        payload: { type: "object", description: "Arbitrary JSON payload to forward to the device." },
                    },
                    required: ["payload"],
                },
            },
        };
    });
}

function devicesSummary(assigned: DeviceTool[]): string {
    if (assigned.length === 0) return "(no devices registered)";
    return assigned.map(({ shortId, device }) => {
        const status = device.connected ? "CONNECTED" : "OFFLINE";
        return `- ${shortId} [${status}]: ${device.description}`;
    }).join("\n");
}

export function buildSystemPrompt(config: {
    assigned: DeviceTool[];
    additionalPrompt: string;
}): string {
    let prompt = `You are a control assistant for a user's connected devices. Each device has a short ID (dev1, dev2, ...) and a human description. Refer to devices by their short ID in your replies. Use the corresponding tool to send a JSON payload to a device; it returns the device's response. Prefer CONNECTED devices when possible. Keep replies short.

IMPORTANT CONTEXT: Most prompts you receive arrive via Google Home's Smart Home protocol, which has a fixed vocabulary of intents (OnOff, AppSelector/appSelect, TransportControl, Channel, InputSelector, Volume, Modes, Toggles, Brightness, etc.) that the user's voice gets squeezed into before reaching us. Google Home does NOT understand what our user's actual devices can do — it only knows the generic Smart Home traits we declared to it. So you will frequently see requests like \`appSelect{newApplication: "play_avatar"}\` or \`OnOff{on:true}\` that don't literally make sense for the user's connected devices. Treat these as Google's best-effort encoding of a natural-language wish: infer what the user actually wanted, then map it onto the *real* capabilities advertised by the connected devices (read each device's \`Capabilities\` carefully — that's the source of truth for what each device can actually do, not the Google Home protocol).

For example: \`appSelect{newApplication:"play_avatar"}\` likely means "the user said something like 'play Avatar'" — search the connected devices for one that can play media or show content, and call its tool with a payload that matches *its* capability schema (e.g. \`{action:"play", title:"Avatar"}\` if the device exposes a "play" action). The protocol the device speaks is whatever its capabilities say, not Smart Home traits.

If you don't know what to do with the user's request, look for a device whose capabilities advertise a "show" or "message" action and forward the request there (e.g. payload \`{"action":"show","text":"..."}\` or \`{"action":"message","text":"..."}\`). When in doubt, surface information rather than failing silently.

Available devices:
${devicesSummary(config.assigned)}`;
    if (config.additionalPrompt.trim()) {
        prompt += `\n\nAdditional instructions from the user:\n${config.additionalPrompt}`;
    }
    return prompt;
}

async function callOpenRouter(config: {
    messages: ChatMessage[];
    tools: ToolDef[];
}): Promise<OpenRouterResponse> {
    const key = loadOpenRouterKey();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "authorization": `Bearer ${key}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: LLM_MODEL,
            messages: config.messages,
            tools: config.tools,
            usage: { include: true },
        }),
    });
    const data = await res.json() as OpenRouterResponse;
    if (data.error) throw new Error(`OpenRouter: ${data.error.message}`);
    if (!data.choices || data.choices.length === 0) {
        throw new Error(`OpenRouter: no choices in response: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
}

export async function runLLMWithDeviceTools(config: {
    accountPubkey: string;
    prompt: string;
    devices: DeviceForLLM[];
    additionalPrompt: string;
    sendToDevice: (config: { devicePubkey: string; payload: unknown }) => Promise<unknown>;
}): Promise<{ reply: string; toolCallsUsed: number; costUsd: number; dailyCostUsd: number }> {
    assertDailyCostBelowCap(config.accountPubkey);

    const assigned = assignShortIds(config.devices);
    const toolMap = new Map<string, DeviceForLLM>();
    for (const { shortId, device } of assigned) toolMap.set(shortId, device);
    const tools = buildTools(assigned);

    const messages: ChatMessage[] = [
        {
            role: "system",
            content: buildSystemPrompt({ assigned, additionalPrompt: config.additionalPrompt }),
        },
        { role: "user", content: config.prompt },
    ];

    let totalCostUsd = 0;
    let toolCallsUsed = 0;

    const su = isSuperuser(config.accountPubkey);

    for (let iter = 0; iter < LLM_MAX_TOOL_ITERATIONS; iter++) {
        assertDailyCostBelowCap(config.accountPubkey);

        const response = await callOpenRouter({ messages, tools });
        const cost = response.usage && response.usage.cost || 0;
        totalCostUsd += cost;
        if (cost > 0) addToDailyCost({ pubkey: config.accountPubkey, deltaUsd: cost });

        if (su) {
            log("llm", `[SU] response account=${config.accountPubkey.slice(0, 16)}... iter=${iter} cost=$${cost}`, response);
            recordLlmResponse({ accountPubkey: config.accountPubkey, iter, costUsd: cost, response });
        }

        const choice = response.choices[0];
        const msg = choice.message;
        messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
            const dailyCostUsd = getCurrentDailyCost(config.accountPubkey);
            return { reply: msg.content || "", toolCallsUsed, costUsd: totalCostUsd, dailyCostUsd };
        }

        for (const tc of msg.tool_calls) {
            toolCallsUsed++;
            const device = toolMap.get(tc.function.name);
            const argumentsRaw = tc.function.arguments || "";
            let sentPayload: unknown = undefined;
            let toolResult: unknown;
            let errMsg: string | undefined;
            if (!device) {
                errMsg = `Unknown tool ${tc.function.name}`;
                toolResult = { error: errMsg };
            } else {
                try {
                    const args = JSON.parse(argumentsRaw || "{}") as { payload?: unknown };
                    sentPayload = args.payload === undefined ? args : args.payload;
                    toolResult = await config.sendToDevice({ devicePubkey: device.devicePubkey, payload: sentPayload });
                } catch (err) {
                    errMsg = (err as Error).message || String(err);
                    toolResult = { error: errMsg };
                }
            }

            if (su) {
                log("llm", `[SU] tool-call account=${config.accountPubkey.slice(0, 16)}... tool=${tc.function.name} device=${device ? device.devicePubkey.slice(0, 16) + "..." : "(unknown)"}`, {
                    argumentsRaw,
                    sentPayload,
                    result: toolResult,
                    error: errMsg,
                });
                recordToolCall({
                    accountPubkey: config.accountPubkey,
                    toolName: tc.function.name,
                    devicePubkey: device ? device.devicePubkey : "",
                    argumentsRaw,
                    sentPayload,
                    result: errMsg === undefined ? toolResult : undefined,
                    error: errMsg,
                });
            }

            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        }
    }

    log("llm", `hit max iterations (${LLM_MAX_TOOL_ITERATIONS}) account=${config.accountPubkey.slice(0, 16)}...`);
    const dailyCostUsd = getCurrentDailyCost(config.accountPubkey);
    return {
        reply: "Iteration limit reached without final reply.",
        toolCallsUsed,
        costUsd: totalCostUsd,
        dailyCostUsd,
    };
}

export const _testHelpers = { shortIdFor, LLM_DAILY_COST_CAP_USD };
