import { getAccount, setSuperuser } from "../nodejs/accounts";
import { validateSpkiPubkey } from "../nodejs/crypto";
import { db } from "../nodejs/db";
import { pubkeyFingerprint } from "../nodejs/fingerprint";

function usage(): never {
    console.error("Usage:");
    console.error("  typenode scripts/setSuperuser.ts <grant|revoke> <base64-spki-pubkey>");
    console.error("  typenode scripts/setSuperuser.ts <grant|revoke> <word1> <word2> [...]");
    console.error("");
    console.error("Word form: matches accounts whose fingerprint phrase starts with the given words.");
    process.exit(2);
}

function resolvePubkey(args: string[]): string {
    if (args.length === 0) usage();

    // Single arg that decodes as a valid SPKI -> treat as pubkey.
    if (args.length === 1) {
        try {
            void validateSpkiPubkey(args[0]);
            return args[0];
        } catch {
            // fall through to word-prefix
        }
    }

    const prefix = args.map(w => w.toLowerCase());
    const rows = db.prepare(`SELECT pubkey FROM accounts`).all() as { pubkey: string }[];
    const matches: { pubkey: string; phrase: string }[] = [];
    for (const row of rows) {
        const phrase = pubkeyFingerprint(row.pubkey);
        const phraseWords = phrase.split(" ");
        let ok = true;
        for (let i = 0; i < prefix.length; i++) {
            if (phraseWords[i] !== prefix[i]) { ok = false; break; }
        }
        if (ok) matches.push({ pubkey: row.pubkey, phrase });
    }

    if (matches.length === 0) {
        console.error(`No account matches word prefix: ${prefix.join(" ")}`);
        console.error(`(checked ${rows.length} account${rows.length === 1 ? "" : "s"})`);
        process.exit(3);
    }
    if (matches.length > 1) {
        console.error(`Word prefix ${JSON.stringify(prefix.join(" "))} is ambiguous; ${matches.length} accounts match:`);
        for (const m of matches.slice(0, 10)) {
            console.error(`  ${m.pubkey.slice(0, 24)}... — ${m.phrase.split(" ").slice(0, 8).join(" ")}...`);
        }
        process.exit(4);
    }
    return matches[0].pubkey;
}

async function main() {
    const [, , subcommand, ...rest] = process.argv;
    if (!subcommand) usage();

    let value: boolean;
    if (subcommand === "grant") value = true;
    else if (subcommand === "revoke") value = false;
    else usage();

    const pubkey = resolvePubkey(rest);
    try {
        await validateSpkiPubkey(pubkey);
    } catch (err) {
        console.error(`Resolved pubkey is not a valid base64 P-256 SPKI: ${(err as Error).message}`);
        process.exit(3);
    }

    setSuperuser({ pubkey, value });
    const after = getAccount(pubkey);
    if (!after) {
        console.error(`Account row missing after upsert (unexpected)`);
        process.exit(5);
    }
    const phrase = pubkeyFingerprint(pubkey);
    console.log(`account ${pubkey.slice(0, 24)}... superuser=${!!after.superuser}`);
    console.log(`fingerprint: ${phrase.split(" ").slice(0, 6).join(" ")}...`);
}

main().catch(err => { console.error(err); process.exit(1); });
