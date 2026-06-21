# Project rules

These are the binding rules for working in this repo. They mirror the
sliftutils conventions (which were imported from `.cursor/rules/*.mdc`).

This project is server-only — no React, no MobX, no DOM. Style rules below
that reference preact/MobX/css helpers do not apply here.

## General guidelines

- Don't run shell commands when you need to create or move small code files. Use tool calls. Use tool calls to make files within folders — you don't need to make the folder, just make the file, the folder will be created automatically.
- If you need to add a dependency, don't just edit `package.json`. Use `yarn add` so you get the latest version, unless the user specifies a version.
- Use tool calls to read files and directories instead of running `ls`, `dir`, etc.
- The server runs as a systemd daemon (`heygoogle.service`, unit at `systemd/heygoogle.service` in repo, installed copy at `/etc/systemd/system/heygoogle.service`). It auto-starts on boot and auto-restarts on crash. After code changes: `systemctl restart heygoogle`. Logs are journal-only: `journalctl -u heygoogle.service -f`.
- The `yarn start/stop/restart/tail` scripts are for ad-hoc local testing only; in normal ops you use `systemctl restart heygoogle` and `journalctl -u heygoogle -f`. The two paths conflict (only one process can hold port 7951), so stop the daemon before running ad-hoc.

## Coding styles

- Times should almost always be in milliseconds; assume milliseconds if not told otherwise.
- Don't make functions that will never be reused and are short. If under 5 lines and not reused, don't create it unless explicitly told to.
- Comments are used sparingly and only when required to explain what's being done. A comment that just restates the function name is forbidden.
- Comments go on the line BEFORE the statement, never trailing the semicolon.
- Use `undefined`, not `null`.
- Almost never check for `undefined`/`null` specifically — just check truthiness.
- When a function has more than one primitive parameter that could be confused (e.g. start and end time), put them inside a single object parameter called `config`.
- Never use return codes — always throw. Include context (expected vs actual). If values could be huge (e.g. file parsing), limit to ~500 characters.
- Use double quotes, not single quotes.
- Never use the ternary operator. Convert `x ? y : z` into `x && y || z`.
- Never use the non-null assertion operator (`!`). Check the value; if needed in nested closures, copy into a `const` to preserve narrowed type.
- Errors use template strings that include the actual offending value and the expected one: `throw new Error(\`Expected X, was \${y}\`);`
- Don't use `switch`. Use `if/else`.
- Don't use `!` to access a value from a `Map`. Use `get` + initialize-if-undefined + `set`.
- Prefer early `return` over deep `else`. Handle error cases, warn/throw, then return. The main case should be at the bottom, not nested.
- Use functions to remove duplication only when something is actually duplicated.
- Do not redefine types. Import them.
- Do not annotate types that can be inferred.
- Constants that might need reconfiguration go near the top of the file under the imports, not buried in functions.
- Never use environment variables. Configuration goes on disk or via CLI args.
- Don't use `as any`.
- When fetch returns `any`, cast it to the real type rather than leaving it as `any`. Same for any deserialized value.
- DO NOT redeclare constants or types — IMPORT THEM.
- Don't try/catch for no reason. If you can't handle the exception, let it throw.

## Layout

- `nodejs/` — server code (run with `typenode ./nodejs/server.ts`)
- `scripts/` — one-off ops (cloudflare provisioning, cert renewal, icon generation).
- `assets/` — committed binary deliverables (e.g. the 144×144 app icon).

Secrets and runtime state live **outside the repo** at `~/heygoogle-data/`:
- `clientSecret.json` — OAuth client id + secret
- `tokens.json` — issued access/refresh tokens
- `devices.json` — optional override for `DEFAULT_DEVICES`
- `server.log` — single consolidated log
- `server.pid` — running pid
- `tls/origin.crt` + `tls/origin.key` — Let's Encrypt cert (DNS-01) for the public endpoint
- `tls/letsencrypt-account.key` — ACME account key

Cloudflare API token is at `~/vidgridweb.com.key` (separate from this project).

Never put secrets inside the repo dir — `~/heygoogle-data/` is the only place they live.

## Smart Home shape

- Fulfillment URL: `https://heygoogle.vidgridweb.com:7951/smarthome/fulfillment`
- OAuth authorize:  `https://heygoogle.vidgridweb.com:7951/oauth/authorize`
- OAuth token:      `https://heygoogle.vidgridweb.com:7951/oauth/token`
- DNS is grey-cloud (DNS-only). Cloudflare is *not* proxying — Google hits the origin directly on port 7951.
- TLS at origin uses a real Let's Encrypt cert provisioned via DNS-01 against the Cloudflare zone.
- If Google's Actions Console rejects non-443 ports, fall back to proxy + Origin Rule and run on 443 via Cloudflare.
