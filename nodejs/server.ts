import https from "https";
import http from "http";
import fs from "fs";
import { URL } from "url";
import { PORT, PUBLIC_HOST, PUBLIC_ORIGIN, TLS_CERT_PATH, TLS_KEY_PATH } from "./config";
import { log, logErr } from "./log";
import { handleAuthorize, handleToken } from "./oauth";
import { handleFulfillment } from "./smarthome";
import { loadClientSecret } from "./storage";

function sendText(res: http.ServerResponse, status: number, body: string) {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", `https://${PUBLIC_HOST}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/") {
        sendText(res, 200, "heygoogle smart home action — OK");
        return;
    }
    if (method === "GET" && pathname === "/healthz") {
        sendText(res, 200, "ok");
        return;
    }
    if (method === "GET" && pathname === "/oauth/authorize") {
        handleAuthorize(req, res, url);
        return;
    }
    if (method === "POST" && pathname === "/oauth/token") {
        await handleToken(req, res);
        return;
    }
    if (method === "POST" && pathname === "/smarthome/fulfillment") {
        await handleFulfillment(req, res);
        return;
    }
    log("http", `404 ${method} ${pathname}`);
    sendText(res, 404, `no route for ${method} ${pathname}`);
}

function main() {
    if (!fs.existsSync(TLS_CERT_PATH) || !fs.existsSync(TLS_KEY_PATH)) {
        throw new Error(`Missing TLS cert at ${TLS_CERT_PATH} or key at ${TLS_KEY_PATH}. Run \`yarn provision-cloudflare\` first.`);
    }
    const client = loadClientSecret();
    log("boot", `client_id=${client.clientId} client_secret=${client.clientSecret}`);

    const server = https.createServer(
        {
            cert: fs.readFileSync(TLS_CERT_PATH),
            key: fs.readFileSync(TLS_KEY_PATH),
        },
        (req, res) => {
            route(req, res).catch(err => {
                logErr("err", `${req.method} ${req.url}`, err);
                sendText(res, 500, `internal error: ${err && err.message || err}`);
            });
        },
    );

    server.listen(PORT, "0.0.0.0", () => {
        log("boot", `listening on https://0.0.0.0:${PORT} (public: ${PUBLIC_ORIGIN})`);
    });
}

main();
