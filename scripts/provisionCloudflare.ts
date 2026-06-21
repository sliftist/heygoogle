import fs from "fs";
import path from "path";
import acme from "acme-client";
import { PUBLIC_HOST, TLS_CERT_PATH, TLS_KEY_PATH } from "../nodejs/config";

const CF_TOKEN_PATH = path.join(process.env.HOME || "/root", "vidgridweb.com.key");
const ZONE_NAME = "vidgridweb.com";
const ORIGIN_IPV4 = "65.109.93.113";
const ACME_EMAIL = "sliftist@gmail.com";
const ACCOUNT_KEY_PATH = path.join(__dirname, "..", "tls", "letsencrypt-account.key");

function readToken(): string {
    return fs.readFileSync(CF_TOKEN_PATH, "utf8").trim();
}

const TOKEN = readToken();

async function cf<T>(config: { method: string; path: string; body?: unknown }): Promise<T> {
    let body: string | undefined;
    if (config.body !== undefined) body = JSON.stringify(config.body);
    const res = await fetch(`https://api.cloudflare.com/client/v4${config.path}`, {
        method: config.method,
        headers: {
            "authorization": `Bearer ${TOKEN}`,
            "content-type": "application/json",
        },
        body,
    });
    const data = await res.json() as { success: boolean; errors: unknown[]; result: T };
    if (!data.success) {
        throw new Error(`Cloudflare API ${config.method} ${config.path} failed: ${JSON.stringify(data.errors).slice(0, 500)}`);
    }
    return data.result;
}

async function getZoneId(): Promise<string> {
    const zones = await cf<{ id: string; name: string }[]>({
        method: "GET",
        path: `/zones?name=${ZONE_NAME}`,
    });
    const zone = zones[0];
    if (!zone) throw new Error(`Expected zone ${ZONE_NAME}, none returned`);
    return zone.id;
}

async function ensureARecord(zoneId: string) {
    const existing = await cf<{ id: string; type: string; name: string; content: string; proxied: boolean }[]>({
        method: "GET",
        path: `/zones/${zoneId}/dns_records?name=${PUBLIC_HOST}&type=A`,
    });
    const desired = { type: "A", name: PUBLIC_HOST, content: ORIGIN_IPV4, proxied: true, ttl: 1 };
    const found = existing[0];
    if (!found) {
        await cf({ method: "POST", path: `/zones/${zoneId}/dns_records`, body: desired });
        console.log(`[dns] created A ${PUBLIC_HOST} -> ${ORIGIN_IPV4} (proxied)`);
        return;
    }
    if (found.content !== ORIGIN_IPV4 || found.proxied !== true) {
        await cf({ method: "PUT", path: `/zones/${zoneId}/dns_records/${found.id}`, body: desired });
        console.log(`[dns] updated A ${PUBLIC_HOST} -> ${ORIGIN_IPV4} (proxied)`);
        return;
    }
    console.log(`[dns] A ${PUBLIC_HOST} -> ${ORIGIN_IPV4} (proxied) already present`);
}

async function createTxtRecord(zoneId: string, name: string, value: string): Promise<string> {
    const created = await cf<{ id: string }>({
        method: "POST",
        path: `/zones/${zoneId}/dns_records`,
        body: { type: "TXT", name, content: value, ttl: 60 },
    });
    return created.id;
}

async function deleteRecord(zoneId: string, recordId: string) {
    await cf({ method: "DELETE", path: `/zones/${zoneId}/dns_records/${recordId}` });
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadOrCreateAccountKey(): Promise<Buffer> {
    if (fs.existsSync(ACCOUNT_KEY_PATH)) return fs.readFileSync(ACCOUNT_KEY_PATH);
    const key = await acme.crypto.createPrivateKey();
    fs.mkdirSync(path.dirname(ACCOUNT_KEY_PATH), { recursive: true });
    fs.writeFileSync(ACCOUNT_KEY_PATH, key);
    return key;
}

async function issueCertificate(zoneId: string) {
    if (fs.existsSync(TLS_CERT_PATH) && fs.existsSync(TLS_KEY_PATH)) {
        const ageMs = Date.now() - fs.statSync(TLS_CERT_PATH).mtimeMs;
        const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
        if (ageMs < sixtyDaysMs) {
            console.log(`[acme] cert at ${TLS_CERT_PATH} is fresh (${Math.floor(ageMs / 86400000)}d old); skipping issuance`);
            return;
        }
    }
    const accountKey = await loadOrCreateAccountKey();
    const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey,
    });

    const [csrKey, csr] = await acme.crypto.createCsr({ commonName: PUBLIC_HOST });

    const cert = await client.auto({
        csr,
        email: ACME_EMAIL,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
            if (challenge.type !== "dns-01") throw new Error(`Expected dns-01, got ${challenge.type}`);
            const recordName = `_acme-challenge.${authz.identifier.value}`;
            console.log(`[acme] creating TXT ${recordName} = ${keyAuthorization}`);
            await createTxtRecord(zoneId, recordName, keyAuthorization);
            console.log(`[acme] waiting 30s for DNS propagation`);
            await delay(30_000);
        },
        challengeRemoveFn: async (authz) => {
            const recordName = `_acme-challenge.${authz.identifier.value}`;
            const found = await cf<{ id: string }[]>({
                method: "GET",
                path: `/zones/${zoneId}/dns_records?type=TXT&name=${recordName}`,
            });
            for (const r of found) {
                console.log(`[acme] deleting TXT ${recordName} (id=${r.id})`);
                await deleteRecord(zoneId, r.id);
            }
        },
    });

    fs.mkdirSync(path.dirname(TLS_CERT_PATH), { recursive: true });
    fs.writeFileSync(TLS_CERT_PATH, cert);
    fs.writeFileSync(TLS_KEY_PATH, csrKey);
    console.log(`[acme] wrote cert to ${TLS_CERT_PATH}`);
    console.log(`[acme] wrote key to ${TLS_KEY_PATH}`);
}

async function main() {
    const zoneId = await getZoneId();
    console.log(`[zone] ${ZONE_NAME} -> ${zoneId}`);
    await ensureARecord(zoneId);
    await issueCertificate(zoneId);
    console.log(`[done] DNS + TLS provisioned for ${PUBLIC_HOST}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
