import { getAccount, setSuperuser } from "../nodejs/accounts";
import { validateSpkiPubkey } from "../nodejs/crypto";

function usage(): never {
    console.error("Usage: typenode scripts/setSuperuser.ts <grant|revoke> <base64-spki-pubkey>");
    process.exit(2);
}

async function main() {
    const [, , subcommand, pubkey] = process.argv;
    if (!subcommand || !pubkey) usage();

    let value: boolean;
    if (subcommand === "grant") value = true;
    else if (subcommand === "revoke") value = false;
    else usage();

    try {
        await validateSpkiPubkey(pubkey);
    } catch (err) {
        console.error(`Pubkey is not a valid base64 P-256 SPKI: ${(err as Error).message}`);
        process.exit(3);
    }

    setSuperuser({ pubkey, value });
    const after = getAccount(pubkey);
    if (!after) {
        console.error(`Account row missing after upsert (unexpected)`);
        process.exit(4);
    }
    console.log(`account ${pubkey.slice(0, 24)}... superuser=${!!after.superuser}`);
}

main().catch(err => { console.error(err); process.exit(1); });
