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
export const DEVICES_PATH = path.join(DATA_DIR, "devices.json");
export const SQLITE_PATH = path.join(DATA_DIR, "heygoogle.sqlite");
export const SERVER_LOG_PATH = path.join(DATA_DIR, "server.log");
export const SERVER_PID_PATH = path.join(DATA_DIR, "server.pid");

export const OPENROUTER_KEY_PATH = path.join(HOME, "openrouter.json");

export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export const GOOGLE_REDIRECT_PREFIXES = [
    "https://oauth-redirect.googleusercontent.com/r/",
    "https://oauth-redirect-sandbox.googleusercontent.com/r/",
];

export const EXTERNAL_AUTHORIZE_URL = "https://vidgridweb.com?page=heygoogle";

export const CORS_ROOT_DOMAIN = ["vidgridweb", "com"];

export const ENVELOPE_TIMESTAMP_WINDOW_MS = 60 * 1000;

export const MAX_IPS_PER_ACCOUNT = 100;

export const PENDING_PAIRING_TTL_MS = 10 * 60 * 1000;

export const SEND_TO_DEVICE_DEFAULT_TIMEOUT_MS = 10 * 1000;

export const LLM_MODEL = "google/gemini-3.1-flash-lite";
export const LLM_DAILY_COST_CAP_USD = 0.15;
export const LLM_MAX_TOOL_ITERATIONS = 10;
export const LLM_INACTIVE_DEVICES_IN_CONTEXT = 3;
export const WS_PATH = "/control";
