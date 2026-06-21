import { LLM_DAILY_COST_CAP_USD, MAX_IPS_PER_ACCOUNT, MAX_SU_GOOGLE_REQUESTS } from "./config";
import { db, todayYMD } from "./db";

export { LLM_DAILY_COST_CAP_USD };

const stmtUpsertAccount = db.prepare(`
INSERT INTO accounts (pubkey, created_at) VALUES (?, ?)
ON CONFLICT(pubkey) DO NOTHING
`);

const stmtUpsertIp = db.prepare(`
INSERT INTO account_ips (pubkey, ip, last_used_at) VALUES (?, ?, ?)
ON CONFLICT(pubkey, ip) DO UPDATE SET last_used_at = excluded.last_used_at
`);

const stmtCountIps = db.prepare(`SELECT COUNT(*) AS n FROM account_ips WHERE pubkey = ?`);

const stmtDeleteOldestIps = db.prepare(`
DELETE FROM account_ips
WHERE pubkey = ? AND (pubkey, last_used_at) IN (
    SELECT pubkey, last_used_at FROM account_ips
    WHERE pubkey = ?
    ORDER BY last_used_at ASC
    LIMIT ?
)
`);

const stmtListIps = db.prepare(`
SELECT ip, last_used_at FROM account_ips WHERE pubkey = ? ORDER BY last_used_at DESC LIMIT ?
`);

const stmtGetAccount = db.prepare(`SELECT pubkey, created_at, daily_cost_usd, daily_cost_date, superuser FROM accounts WHERE pubkey = ?`);

const stmtSetSuperuser = db.prepare(`UPDATE accounts SET superuser = ? WHERE pubkey = ?`);

const stmtUpdateDailyCost = db.prepare(`UPDATE accounts SET daily_cost_usd = ?, daily_cost_date = ? WHERE pubkey = ?`);

const stmtInsertGoogleLink = db.prepare(`
INSERT INTO google_links (google_user_id, account_pubkey, linked_at) VALUES (?, ?, ?)
ON CONFLICT(google_user_id) DO UPDATE SET account_pubkey = excluded.account_pubkey, linked_at = excluded.linked_at
`);

const stmtListGoogleLinks = db.prepare(`SELECT google_user_id, linked_at FROM google_links WHERE account_pubkey = ? ORDER BY linked_at DESC`);

const stmtDeleteGoogleLink = db.prepare(`DELETE FROM google_links WHERE account_pubkey = ? AND google_user_id = ?`);

const stmtDeleteOauthTokensForGoogleLink = db.prepare(`DELETE FROM oauth_tokens WHERE google_user_id = ?`);

export type AccountRow = {
    pubkey: string;
    created_at: number;
    daily_cost_usd: number;
    daily_cost_date: string;
    superuser: number;
};

export function ensureAccount(pubkey: string): void {
    stmtUpsertAccount.run(pubkey, Date.now());
}

export function touchAccount(config: { pubkey: string; ip: string }): void {
    ensureAccount(config.pubkey);
    stmtUpsertIp.run(config.pubkey, config.ip, Date.now());
    const row = stmtCountIps.get(config.pubkey) as { n: number };
    if (row.n > MAX_IPS_PER_ACCOUNT) {
        const excess = row.n - MAX_IPS_PER_ACCOUNT;
        stmtDeleteOldestIps.run(config.pubkey, config.pubkey, excess);
    }
}

export function getAccount(pubkey: string): AccountRow | undefined {
    return stmtGetAccount.get(pubkey) as AccountRow | undefined;
}

export function listAccountIps(pubkey: string, limit = MAX_IPS_PER_ACCOUNT): { ip: string; last_used_at: number }[] {
    return stmtListIps.all(pubkey, limit) as { ip: string; last_used_at: number }[];
}

export function addGoogleLink(config: { googleUserId: string; pubkey: string }): void {
    stmtInsertGoogleLink.run(config.googleUserId, config.pubkey, Date.now());
}

export function listGoogleLinks(pubkey: string): { google_user_id: string; linked_at: number }[] {
    return stmtListGoogleLinks.all(pubkey) as { google_user_id: string; linked_at: number }[];
}

export function removeGoogleLink(config: { pubkey: string; googleUserId: string }): { removed: boolean } {
    const info = stmtDeleteGoogleLink.run(config.pubkey, config.googleUserId);
    stmtDeleteOauthTokensForGoogleLink.run(config.googleUserId);
    return { removed: info.changes > 0 };
}

export function getCurrentDailyCost(pubkey: string): number {
    const acct = getAccount(pubkey);
    if (!acct) return 0;
    const today = todayYMD();
    if (acct.daily_cost_date !== today) return 0;
    return acct.daily_cost_usd;
}

export function addToDailyCost(config: { pubkey: string; deltaUsd: number }): { newTotal: number } {
    ensureAccount(config.pubkey);
    const today = todayYMD();
    const current = getCurrentDailyCost(config.pubkey);
    const newTotal = current + config.deltaUsd;
    stmtUpdateDailyCost.run(newTotal, today, config.pubkey);
    return { newTotal };
}

export function assertDailyCostBelowCap(pubkey: string): void {
    const current = getCurrentDailyCost(pubkey);
    if (current >= LLM_DAILY_COST_CAP_USD) {
        throw new Error(`Daily LLM cost cap reached: $${current.toFixed(4)} >= $${LLM_DAILY_COST_CAP_USD}`);
    }
}

export function setSuperuser(config: { pubkey: string; value: boolean }): { ok: boolean } {
    ensureAccount(config.pubkey);
    const info = stmtSetSuperuser.run(config.value ? 1 : 0, config.pubkey);
    return { ok: info.changes > 0 };
}

export function isSuperuser(pubkey: string): boolean {
    const acct = getAccount(pubkey);
    return !!(acct && acct.superuser);
}

const stmtInsertSuRequest = db.prepare(`
INSERT INTO superuser_request_log (account_pubkey, received_at, intent, raw_body) VALUES (?, ?, ?, ?)
`);

const stmtTrimSuRequests = db.prepare(`
DELETE FROM superuser_request_log
WHERE account_pubkey = ? AND id NOT IN (
    SELECT id FROM superuser_request_log
    WHERE account_pubkey = ?
    ORDER BY id DESC
    LIMIT ?
)
`);

const stmtListSuRequests = db.prepare(`
SELECT received_at, intent, raw_body FROM superuser_request_log
WHERE account_pubkey = ?
ORDER BY id DESC
LIMIT ?
`);

export type SuRequestRow = {
    received_at: number;
    intent: string;
    raw_body: string;
};

export function recordGoogleRequest(config: { accountPubkey: string; intent: string; rawBody: string }): void {
    stmtInsertSuRequest.run(config.accountPubkey, Date.now(), config.intent, config.rawBody);
    stmtTrimSuRequests.run(config.accountPubkey, config.accountPubkey, MAX_SU_GOOGLE_REQUESTS);
}

export function listSuGoogleRequests(accountPubkey: string, limit = MAX_SU_GOOGLE_REQUESTS): SuRequestRow[] {
    return stmtListSuRequests.all(accountPubkey, limit) as SuRequestRow[];
}
