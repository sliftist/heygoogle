import { PENDING_PAIRING_TTL_MS } from "./config";
import { db } from "./db";

const stmtInsertPending = db.prepare(`
INSERT INTO pending_pairings (device_pubkey, otp, description, capabilities_json, created_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(device_pubkey) DO UPDATE SET otp = excluded.otp, description = excluded.description, capabilities_json = excluded.capabilities_json, created_at = excluded.created_at
`);

const stmtGetPending = db.prepare(`SELECT device_pubkey, otp, description, capabilities_json, created_at FROM pending_pairings WHERE device_pubkey = ?`);

const stmtDeletePending = db.prepare(`DELETE FROM pending_pairings WHERE device_pubkey = ?`);

const stmtPurgeExpiredPendings = db.prepare(`DELETE FROM pending_pairings WHERE created_at < ?`);

const stmtInsertDevice = db.prepare(`
INSERT INTO devices (device_pubkey, account_pubkey, description, capabilities_json, registered_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(device_pubkey, account_pubkey) DO UPDATE SET description = excluded.description, capabilities_json = excluded.capabilities_json
`);

const stmtListDevicesForAccount = db.prepare(`
SELECT device_pubkey, description, capabilities_json, registered_at, last_active_at FROM devices WHERE account_pubkey = ? ORDER BY last_active_at DESC
`);

const stmtListAccountsForDevice = db.prepare(`
SELECT account_pubkey, registered_at FROM devices WHERE device_pubkey = ? ORDER BY registered_at DESC
`);

const stmtDeleteDevice = db.prepare(`DELETE FROM devices WHERE account_pubkey = ? AND device_pubkey = ?`);

const stmtUpdateDescription = db.prepare(`UPDATE devices SET description = ? WHERE account_pubkey = ? AND device_pubkey = ?`);

const stmtUpdateCapabilities = db.prepare(`UPDATE devices SET capabilities_json = ? WHERE device_pubkey = ?`);

const stmtDeleteDeviceFromAccount = db.prepare(`DELETE FROM devices WHERE device_pubkey = ? AND account_pubkey = ?`);

const stmtTouchDeviceActive = db.prepare(`UPDATE devices SET last_active_at = ? WHERE device_pubkey = ?`);

const stmtIsDevice = db.prepare(`SELECT 1 AS one FROM devices WHERE device_pubkey = ? LIMIT 1`);

export type PendingPairing = {
    device_pubkey: string;
    otp: string;
    description: string;
    capabilities_json: string;
    created_at: number;
};

export type DeviceRow = {
    device_pubkey: string;
    description: string;
    capabilities_json: string;
    registered_at: number;
    last_active_at: number;
};

export type DeviceAccountRow = {
    account_pubkey: string;
    registered_at: number;
};

function purgeExpired(): void {
    stmtPurgeExpiredPendings.run(Date.now() - PENDING_PAIRING_TTL_MS);
}

export function setPendingPairing(config: {
    devicePubkey: string;
    otp: string;
    description: string;
    capabilities: unknown;
}): void {
    purgeExpired();
    stmtInsertPending.run(config.devicePubkey, config.otp, config.description, JSON.stringify(config.capabilities), Date.now());
}

export function consumePendingPairing(devicePubkey: string, otp: string): PendingPairing | undefined {
    purgeExpired();
    const row = stmtGetPending.get(devicePubkey) as PendingPairing | undefined;
    if (!row) return undefined;
    if (row.otp !== otp) return undefined;
    stmtDeletePending.run(devicePubkey);
    return row;
}

export function registerDeviceForAccount(config: {
    devicePubkey: string;
    accountPubkey: string;
    description: string;
    capabilities: unknown;
}): void {
    stmtInsertDevice.run(
        config.devicePubkey,
        config.accountPubkey,
        config.description,
        JSON.stringify(config.capabilities),
        Date.now(),
        0,
    );
}

export function listDevicesForAccount(accountPubkey: string): DeviceRow[] {
    return stmtListDevicesForAccount.all(accountPubkey) as DeviceRow[];
}

export function listAccountsForDevice(devicePubkey: string): DeviceAccountRow[] {
    return stmtListAccountsForDevice.all(devicePubkey) as DeviceAccountRow[];
}

export function removeDeviceFromAccount(config: { accountPubkey: string; devicePubkey: string }): { removed: boolean } {
    const info = stmtDeleteDevice.run(config.accountPubkey, config.devicePubkey);
    return { removed: info.changes > 0 };
}

export function updateDeviceDescription(config: { accountPubkey: string; devicePubkey: string; description: string }): { updated: boolean } {
    const info = stmtUpdateDescription.run(config.description, config.accountPubkey, config.devicePubkey);
    return { updated: info.changes > 0 };
}

export function updateDeviceCapabilities(config: { devicePubkey: string; capabilities: unknown }): { updatedRows: number } {
    const info = stmtUpdateCapabilities.run(JSON.stringify(config.capabilities), config.devicePubkey);
    return { updatedRows: info.changes };
}

export function removeAccountFromDevice(config: { devicePubkey: string; accountPubkey: string }): { removed: boolean } {
    const info = stmtDeleteDeviceFromAccount.run(config.devicePubkey, config.accountPubkey);
    return { removed: info.changes > 0 };
}

export function touchDeviceActive(devicePubkey: string): void {
    stmtTouchDeviceActive.run(Date.now(), devicePubkey);
}

export function isDevice(pubkey: string): boolean {
    return !!stmtIsDevice.get(pubkey);
}
