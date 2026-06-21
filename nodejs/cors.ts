import http from "http";
import { CORS_ROOT_DOMAIN } from "./config";

function originIsAllowed(origin: string): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    const labels = url.hostname.split(".");
    if (labels.length < CORS_ROOT_DOMAIN.length) return false;
    for (let i = 0; i < CORS_ROOT_DOMAIN.length; i++) {
        if (labels[labels.length - CORS_ROOT_DOMAIN.length + i] !== CORS_ROOT_DOMAIN[i]) return false;
    }
    return true;
}

export function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && originIsAllowed(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader("access-control-allow-credentials", "true");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "Content-Type, Authorization");
        res.setHeader("access-control-max-age", "86400");
    }
}

export function handlePreflight(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.method !== "OPTIONS") return false;
    applyCors(req, res);
    res.writeHead(204);
    res.end();
    return true;
}
