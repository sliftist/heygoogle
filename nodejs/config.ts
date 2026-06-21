import path from "path";

export const PORT = 7951;
export const PUBLIC_HOST = "heygoogle.vidgridweb.com";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}:${PORT}`;

const HOME = process.env.HOME || "/root";
export const DATA_DIR = path.join(HOME, "heygoogle-data");
export const TLS_DIR = path.join(DATA_DIR, "tls");

export const TLS_CERT_PATH = path.join(TLS_DIR, "origin.crt");
export const TLS_KEY_PATH = path.join(TLS_DIR, "origin.key");

export const CLIENT_SECRET_PATH = path.join(DATA_DIR, "clientSecret.json");
export const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");
export const DEVICES_PATH = path.join(DATA_DIR, "devices.json");
export const SERVER_LOG_PATH = path.join(DATA_DIR, "server.log");
export const SERVER_PID_PATH = path.join(DATA_DIR, "server.pid");

export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export const GOOGLE_REDIRECT_PREFIXES = [
    "https://oauth-redirect.googleusercontent.com/r/",
    "https://oauth-redirect-sandbox.googleusercontent.com/r/",
];
