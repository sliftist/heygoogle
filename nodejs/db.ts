import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { DATA_DIR, SQLITE_PATH } from "./config";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(SQLITE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
    pubkey TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    daily_cost_usd REAL NOT NULL DEFAULT 0,
    daily_cost_date TEXT NOT NULL DEFAULT '',
    superuser INTEGER NOT NULL DEFAULT 0,
    additional_prompt TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS account_ips (
    pubkey TEXT NOT NULL,
    ip TEXT NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY (pubkey, ip)
);
CREATE INDEX IF NOT EXISTS idx_account_ips_last ON account_ips(pubkey, last_used_at);

CREATE TABLE IF NOT EXISTS google_links (
    google_user_id TEXT PRIMARY KEY,
    account_pubkey TEXT NOT NULL,
    linked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_links_pubkey ON google_links(account_pubkey);

CREATE TABLE IF NOT EXISTS devices (
    device_pubkey TEXT NOT NULL,
    account_pubkey TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_pubkey, account_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_pubkey);
CREATE INDEX IF NOT EXISTS idx_devices_device ON devices(device_pubkey);

CREATE TABLE IF NOT EXISTS pending_pairings (
    device_pubkey TEXT PRIMARY KEY,
    otp TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    account_pubkey TEXT NOT NULL,
    google_user_id TEXT,
    expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account ON oauth_tokens(account_pubkey);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_google ON oauth_tokens(google_user_id);

CREATE TABLE IF NOT EXISTS superuser_request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_pubkey TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    intent TEXT NOT NULL,
    raw_body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_su_log_account ON superuser_request_log(account_pubkey, id DESC);
`);

const accountCols = db.pragma("table_info(accounts)") as { name: string }[];
if (!accountCols.some(c => c.name === "superuser")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN superuser INTEGER NOT NULL DEFAULT 0`);
}
if (!accountCols.some(c => c.name === "additional_prompt")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN additional_prompt TEXT NOT NULL DEFAULT ''`);
}

export function todayYMD(): string {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
