import http from "http";
import crypto from "crypto";
import { URL, URLSearchParams } from "url";
import {
    ACCESS_TOKEN_TTL_MS,
    EXTERNAL_AUTHORIZE_URL,
    GOOGLE_REDIRECT_PREFIXES,
} from "./config";
import { addGoogleLink, ensureAccount, removeGoogleLink } from "./accounts";
import { db } from "./db";
import { log } from "./log";
import { validateSpkiPubkey } from "./crypto";
import { loadClientSecret } from "./storage";

const stmtInsertToken = db.prepare(`
INSERT INTO oauth_tokens (token, kind, account_pubkey, google_user_id, expires_at) VALUES (?, ?, ?, ?, ?)
`);

const stmtGetAccessToken = db.prepare(`
SELECT account_pubkey, google_user_id, expires_at FROM oauth_tokens WHERE token = ? AND kind = 'access'
`);

const stmtGetRefreshToken = db.prepare(`
SELECT account_pubkey, google_user_id FROM oauth_tokens WHERE token = ? AND kind = 'refresh'
`);

const stmtDeleteTokensForGoogleUser = db.prepare(`DELETE FROM oauth_tokens WHERE google_user_id = ?`);

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
    const responseType = params.get("response_type") || "";

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

    const target = new URL(EXTERNAL_AUTHORIZE_URL);
    for (const [k, v] of params) target.searchParams.set(k, v);

    log("oauth", `authorize -> redirecting to external page client=${clientId}`);
    res.writeHead(302, { location: target.toString() });
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
        return JSON.parse(body) as Record<string, string>;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return out;
}

function mintAccessToken(config: { pubkey: string; googleUserId: string }): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    stmtInsertToken.run(token, "access", config.pubkey, config.googleUserId, expiresAt);
    return { token, expiresAt };
}

function mintRefreshToken(config: { pubkey: string; googleUserId: string }): string {
    const token = crypto.randomBytes(32).toString("hex");
    stmtInsertToken.run(token, "refresh", config.pubkey, config.googleUserId, null);
    return token;
}

export async function handleToken(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readBody(req);
    const contentType = req.headers["content-type"] || "";
    const form = parseFormOrJson(contentType, body);

    const expectedClient = loadClientSecret();
    if (form.client_id && form.client_id !== expectedClient.clientId) {
        sendJSON(res, 400, { error: "invalid_client" });
        return;
    }
    if (form.client_secret && form.client_secret !== expectedClient.clientSecret) {
        sendJSON(res, 400, { error: "invalid_client" });
        return;
    }

    const grantType = form.grant_type || "";

    if (grantType === "authorization_code") {
        const pubkeyB64 = form.code || "";
        try {
            await validateSpkiPubkey(pubkeyB64);
        } catch (err) {
            log("oauth", `token rejected: code is not a valid SPKI pubkey: ${err && (err as Error).message || err}`);
            sendJSON(res, 400, { error: "invalid_grant" });
            return;
        }

        const googleUserId = `glink-${crypto.randomBytes(8).toString("hex")}`;
        ensureAccount(pubkeyB64);
        addGoogleLink({ googleUserId, pubkey: pubkeyB64 });

        const access = mintAccessToken({ pubkey: pubkeyB64, googleUserId });
        const refresh = mintRefreshToken({ pubkey: pubkeyB64, googleUserId });

        log("oauth", `token (code) issued account=${pubkeyB64.slice(0, 16)}... googleUserId=${googleUserId}`);
        sendJSON(res, 200, {
            token_type: "Bearer",
            access_token: access.token,
            refresh_token: refresh,
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        });
        return;
    }

    if (grantType === "refresh_token") {
        const refreshToken = form.refresh_token || "";
        const record = stmtGetRefreshToken.get(refreshToken) as { account_pubkey: string; google_user_id: string } | undefined;
        if (!record) {
            sendJSON(res, 400, { error: "invalid_grant" });
            return;
        }
        const access = mintAccessToken({ pubkey: record.account_pubkey, googleUserId: record.google_user_id });
        log("oauth", `token (refresh) issued account=${record.account_pubkey.slice(0, 16)}... googleUserId=${record.google_user_id}`);
        sendJSON(res, 200, {
            token_type: "Bearer",
            access_token: access.token,
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        });
        return;
    }

    log("oauth", `unsupported grant_type=${grantType}`);
    sendJSON(res, 400, { error: "unsupported_grant_type" });
}

export type BearerIdentity = {
    pubkey: string;
    googleUserId: string;
};

export function authenticateBearer(req: http.IncomingMessage): BearerIdentity | undefined {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return undefined;
    const token = match[1];
    const record = stmtGetAccessToken.get(token) as { account_pubkey: string; google_user_id: string; expires_at: number } | undefined;
    if (!record) return undefined;
    if (record.expires_at && record.expires_at < Date.now()) return undefined;
    return { pubkey: record.account_pubkey, googleUserId: record.google_user_id };
}

export function invalidateGoogleLink(googleUserId: string): void {
    stmtDeleteTokensForGoogleUser.run(googleUserId);
    const pubkeyRow = db.prepare(`SELECT account_pubkey FROM google_links WHERE google_user_id = ?`).get(googleUserId) as { account_pubkey: string } | undefined;
    if (pubkeyRow) {
        removeGoogleLink({ pubkey: pubkeyRow.account_pubkey, googleUserId });
    }
    log("oauth", `invalidated googleUserId=${googleUserId}`);
}
