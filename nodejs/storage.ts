import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CLIENT_SECRET_PATH, DATA_DIR, DEVICES_PATH } from "./config";

export type ClientSecret = {
    clientId: string;
    clientSecret: string;
};

export type DeviceName = {
    defaultNames?: string[];
    name: string;
    nicknames?: string[];
};

export type Device = {
    id: string;
    type: string;
    traits: string[];
    name: DeviceName;
    willReportState: boolean;
    roomHint?: string;
    attributes?: Record<string, unknown>;
};

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
}

function writeJSON(filePath: string, value: unknown) {
    ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, undefined, 2));
    fs.renameSync(tmp, filePath);
}

export function loadClientSecret(): ClientSecret {
    let existing = readJSON<ClientSecret | undefined>(CLIENT_SECRET_PATH, undefined);
    if (existing) return existing;
    ensureDir(DATA_DIR);
    const fresh: ClientSecret = {
        clientId: `heygoogle-${crypto.randomBytes(8).toString("hex")}`,
        clientSecret: crypto.randomBytes(32).toString("hex"),
    };
    writeJSON(CLIENT_SECRET_PATH, fresh);
    return fresh;
}

const DEFAULT_DEVICES: Device[] = [
    {
        id: "tv-1",
        type: "action.devices.types.TV",
        traits: [
            "action.devices.traits.OnOff",
            "action.devices.traits.TransportControl",
            "action.devices.traits.MediaState",
            "action.devices.traits.AppSelector",
            "action.devices.traits.Volume",
        ],
        name: {
            name: "TV",
            nicknames: ["Living Room TV", "the TV"],
            defaultNames: ["heygoogle TV"],
        },
        willReportState: false,
        attributes: {
            transportControlSupportedCommands: ["NEXT", "PREVIOUS", "PAUSE", "STOP", "RESUME"],
            availableApplications: [
                { key: "netflix", names: [{ name_synonym: ["Netflix"], lang: "en" }] },
                { key: "youtube", names: [{ name_synonym: ["YouTube"], lang: "en" }] },
            ],
            volumeMaxLevel: 100,
            volumeCanMuteAndUnmute: true,
            levelStepSize: 5,
        },
    },
];

export function loadDevices(): Device[] {
    return readJSON<Device[]>(DEVICES_PATH, DEFAULT_DEVICES);
}
