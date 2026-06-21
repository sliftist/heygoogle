import http from "http";
import crypto from "crypto";
import { URL, URLSearchParams } from "url";
import {
    ACCESS_TOKEN_TTL_MS,
    AUTH_CODE_TTL_MS,
    GOOGLE_REDIRECT_PREFIXES,
} from "./config";
import { log } from "./log";
import { loadClientSecret, loadTokens, saveTokens } from "./storage";

function isAllowedRedirect(redirectUri: string): boolean {
    return GOOGLE_REDIRECT_PREFIXES.some(prefix => redirectUri.startsWith(prefix));
}

function sendText(res: http.ServerResponse, status: number, body: string) {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

export function handleAuthorize(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const params = url.searchParams;
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const state = params.get("state") || "";
    const responseType = params.get("response_type") || "";
    const scope = params.get("scope") || "";

    const expectedClient = loadClientSecret();
    if (clientId !== expectedClient.clientId) {
        sendText(res, 400, `Unknown client_id. Expected ${expectedClient.clientId}, was ${clientId}`);
        return;
    }
    if (responseType !== "code") {
        sendText(res, 400, `Expected response_type=code, was ${responseType}`);
        return;
    }
    if (!isAllowedRedirect(redirectUri)) {
        sendText(res, 400, `redirect_uri ${redirectUri} not in allow-list`);
        return;
    }

    const tokens = loadTokens();
    const code = crypto.randomBytes(24).toString("hex");
    const userId = `user-${crypto.randomBytes(8).toString("hex")}`;
    tokens.authCodes[code] = {
        userId,
        clientId,
        redirectUri,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    };
    saveTokens(tokens);

    log("oauth", `authorize code issued user=${userId} client=${clientId} scope=${scope} state=${state}`);

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);

    res.writeHead(302, { location: redirect.toString() });
    res.end();
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function parseFormOrJson(contentType: string, body: string): Record<string, string> {
    if (contentType.includes("application/json")) {
        const parsed = JSON.parse(body) as Record<string, string>;
        return parsed;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return out;
}

export async function handleToken(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readBody(req);
    const contentType = req.headers["content-type"] || "";
    const form = parseFormOrJson(contentType, body);

    const expectedClient = loadClientSecret();
    const givenClientId = form.client_id || (req.headers.authorization || "").replace(/^Basic\s+/i, "");
    const grantType = form.grant_type || "";

    if (form.client_id && form.client_id !== expectedClient.clientId) {
        sendJSON(res, 400, { error: "invalid_client" });
        return;
    }
    if (form.client_secret && form.client_secret !== expectedClient.clientSecret) {
        sendJSON(res, 400, { error: "invalid_client" });
        return;
    }

    const tokens = loadTokens();

    if (grantType === "authorization_code") {
        const code = form.code || "";
        const record = tokens.authCodes[code];
        if (!record) {
            sendJSON(res, 400, { error: "invalid_grant" });
            return;
        }
        if (record.expiresAt < Date.now()) {
            delete tokens.authCodes[code];
            saveTokens(tokens);
            sendJSON(res, 400, { error: "invalid_grant" });
            return;
        }
        delete tokens.authCodes[code];

        const accessToken = crypto.randomBytes(32).toString("hex");
        const refreshToken = crypto.randomBytes(32).toString("hex");
        tokens.accessTokens[accessToken] = {
            userId: record.userId,
            expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
        };
        tokens.refreshTokens[refreshToken] = { userId: record.userId };
        saveTokens(tokens);

        log("oauth", `token (code) issued user=${record.userId}`);
        sendJSON(res, 200, {
            token_type: "Bearer",
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        });
        return;
    }

    if (grantType === "refresh_token") {
        const refreshToken = form.refresh_token || "";
        const record = tokens.refreshTokens[refreshToken];
        if (!record) {
            sendJSON(res, 400, { error: "invalid_grant" });
            return;
        }
        const accessToken = crypto.randomBytes(32).toString("hex");
        tokens.accessTokens[accessToken] = {
            userId: record.userId,
            expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
        };
        saveTokens(tokens);

        log("oauth", `token (refresh) issued user=${record.userId}`);
        sendJSON(res, 200, {
            token_type: "Bearer",
            access_token: accessToken,
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        });
        return;
    }

    log("oauth", `unsupported grant_type=${grantType} client=${givenClientId}`);
    sendJSON(res, 400, { error: "unsupported_grant_type" });
}

export function authenticateBearer(req: http.IncomingMessage): string | undefined {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return undefined;
    const token = match[1];
    const tokens = loadTokens();
    const record = tokens.accessTokens[token];
    if (!record) return undefined;
    if (record.expiresAt < Date.now()) return undefined;
    return record.userId;
}

export function invalidateUser(userId: string) {
    const tokens = loadTokens();
    let removed = 0;
    for (const [token, rec] of Object.entries(tokens.accessTokens)) {
        if (rec.userId === userId) {
            delete tokens.accessTokens[token];
            removed++;
        }
    }
    for (const [token, rec] of Object.entries(tokens.refreshTokens)) {
        if (rec.userId === userId) {
            delete tokens.refreshTokens[token];
            removed++;
        }
    }
    for (const [code, rec] of Object.entries(tokens.authCodes)) {
        if (rec.userId === userId) {
            delete tokens.authCodes[code];
            removed++;
        }
    }
    saveTokens(tokens);
    log("oauth", `invalidated user=${userId} (${removed} tokens removed)`);
}
