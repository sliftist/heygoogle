import fs from "fs";
import path from "path";

const CF_TOKEN_PATH = path.join(process.env.HOME || "/root", "vidgridweb.com.key");
const ZONE_NAME = "vidgridweb.com";
const SUBDOMAIN = "heygoogle.vidgridweb.com";
const ORIGIN_IPV4 = "65.109.93.113";

const TOKEN = fs.readFileSync(CF_TOKEN_PATH, "utf8").trim();

const arg = process.argv[2];
if (arg !== "proxied" && arg !== "dns-only") {
    console.error(`Usage: typenode setDnsMode.ts [proxied|dns-only]; got ${arg}`);
    process.exit(1);
}
const proxied = arg === "proxied";

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

async function main() {
    const zones = await cf<{ id: string }[]>({ method: "GET", path: `/zones?name=${ZONE_NAME}` });
    const zoneId = zones[0].id;
    const found = await cf<{ id: string; content: string; proxied: boolean }[]>({
        method: "GET",
        path: `/zones/${zoneId}/dns_records?name=${SUBDOMAIN}&type=A`,
    });
    const record = found[0];
    if (!record) throw new Error(`Expected A record ${SUBDOMAIN}, none found`);
    if (record.proxied === proxied && record.content === ORIGIN_IPV4) {
        console.log(`[dns] already ${arg}; nothing to do`);
        return;
    }
    await cf({
        method: "PUT",
        path: `/zones/${zoneId}/dns_records/${record.id}`,
        body: { type: "A", name: SUBDOMAIN, content: ORIGIN_IPV4, proxied, ttl: 1 },
    });
    console.log(`[dns] ${SUBDOMAIN} -> ${ORIGIN_IPV4} (${arg})`);
}

main().catch(err => { console.error(err); process.exit(1); });
