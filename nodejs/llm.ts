import fs from "fs";
import crypto from "crypto";
import {
    LLM_DAILY_COST_CAP_USD,
    LLM_MAX_TOOL_ITERATIONS,
    LLM_MODEL,
    OPENROUTER_KEY_PATH,
} from "./config";
import { addToDailyCost, assertDailyCostBelowCap, getCurrentDailyCost } from "./accounts";
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

function deviceToolName(devicePubkey: string): string {
    const hash = crypto.createHash("sha256").update(devicePubkey).digest("hex");
    return `device_${hash.slice(0, 12)}`;
}

function deviceToolByName(devices: DeviceForLLM[]): Map<string, DeviceForLLM> {
    const map = new Map<string, DeviceForLLM>();
    for (const d of devices) map.set(deviceToolName(d.devicePubkey), d);
    return map;
}

function buildTools(devices: DeviceForLLM[]): ToolDef[] {
    return devices.map(d => {
        const status = d.connected ? "CONNECTED" : "OFFLINE";
        const caps = JSON.stringify(d.capabilities);
        return {
            type: "function" as const,
            function: {
                name: deviceToolName(d.devicePubkey),
                description: `[${status}] ${d.description}. Capabilities: ${caps}. Pass a JSON payload appropriate for this device.`,
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
    sendToDevice: (config: { devicePubkey: string; payload: unknown }) => Promise<unknown>;
}): Promise<{ reply: string; toolCallsUsed: number; costUsd: number; dailyCostUsd: number }> {
    assertDailyCostBelowCap(config.accountPubkey);

    const toolMap = deviceToolByName(config.devices);
    const tools = buildTools(config.devices);

    const messages: ChatMessage[] = [
        {
            role: "system",
            content: `You are a control assistant for a user's connected devices. Use the available tools to interact with devices. Each tool sends a JSON payload to one device and returns its response. Prefer CONNECTED devices. Keep messages short. When done, reply with a final natural-language summary.`,
        },
        { role: "user", content: config.prompt },
    ];

    let totalCostUsd = 0;
    let toolCallsUsed = 0;

    for (let iter = 0; iter < LLM_MAX_TOOL_ITERATIONS; iter++) {
        assertDailyCostBelowCap(config.accountPubkey);

        const response = await callOpenRouter({ messages, tools });
        const cost = response.usage && response.usage.cost || 0;
        totalCostUsd += cost;
        if (cost > 0) addToDailyCost({ pubkey: config.accountPubkey, deltaUsd: cost });

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
            let toolResult: unknown;
            if (!device) {
                toolResult = { error: `Unknown tool ${tc.function.name}` };
            } else {
                try {
                    const args = JSON.parse(tc.function.arguments || "{}") as { payload?: unknown };
                    const payload = args.payload === undefined ? args : args.payload;
                    toolResult = await config.sendToDevice({ devicePubkey: device.devicePubkey, payload });
                } catch (err) {
                    toolResult = { error: (err as Error).message || String(err) };
                }
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

export const _testHelpers = { deviceToolName, LLM_DAILY_COST_CAP_USD };
