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

const MEDIA_TRAITS = [
    "action.devices.traits.OnOff",
    "action.devices.traits.TransportControl",
    "action.devices.traits.MediaState",
    "action.devices.traits.AppSelector",
    "action.devices.traits.Volume",
    "action.devices.traits.Channel",
    "action.devices.traits.InputSelector",
    "action.devices.traits.Brightness",
    "action.devices.traits.Modes",
    "action.devices.traits.Toggles",
];

const SHARED_MEDIA_ATTRIBUTES = {
    transportControlSupportedCommands: [
        "NEXT", "PREVIOUS", "PAUSE", "STOP", "RESUME",
        "SEEK_RELATIVE", "SEEK_TO_POSITION", "CAPTION_CONTROL",
    ],
    supportActivityState: true,
    supportPlaybackState: true,
    availableApplications: [
        { key: "netflix", names: [{ name_synonym: ["Netflix"], lang: "en" }] },
        { key: "youtube", names: [{ name_synonym: ["YouTube"], lang: "en" }] },
        { key: "disneyplus", names: [{ name_synonym: ["Disney Plus", "Disney+", "Disney"], lang: "en" }] },
        { key: "primevideo", names: [{ name_synonym: ["Prime Video", "Amazon Prime", "Amazon Prime Video"], lang: "en" }] },
        { key: "hbomax", names: [{ name_synonym: ["HBO Max", "Max", "HBO"], lang: "en" }] },
        { key: "hulu", names: [{ name_synonym: ["Hulu"], lang: "en" }] },
        { key: "appletv", names: [{ name_synonym: ["Apple TV", "Apple TV+", "Apple TV Plus"], lang: "en" }] },
        { key: "paramountplus", names: [{ name_synonym: ["Paramount Plus", "Paramount+", "Paramount"], lang: "en" }] },
        { key: "peacock", names: [{ name_synonym: ["Peacock"], lang: "en" }] },
        { key: "spotify", names: [{ name_synonym: ["Spotify"], lang: "en" }] },
        { key: "plex", names: [{ name_synonym: ["Plex"], lang: "en" }] },
        { key: "twitch", names: [{ name_synonym: ["Twitch"], lang: "en" }] },
        { key: "crunchyroll", names: [{ name_synonym: ["Crunchyroll"], lang: "en" }] },
        { key: "discoveryplus", names: [{ name_synonym: ["Discovery Plus", "Discovery+"], lang: "en" }] },
        { key: "espnplus", names: [{ name_synonym: ["ESPN Plus", "ESPN+", "ESPN"], lang: "en" }] },
        { key: "tubi", names: [{ name_synonym: ["Tubi"], lang: "en" }] },
        { key: "googletv", names: [{ name_synonym: ["Google TV"], lang: "en" }] },
        { key: "youtubekids", names: [{ name_synonym: ["YouTube Kids"], lang: "en" }] },
        { key: "youtubemusic", names: [{ name_synonym: ["YouTube Music"], lang: "en" }] },
        { key: "youtubetv", names: [{ name_synonym: ["YouTube TV"], lang: "en" }] },
        { key: "pluto", names: [{ name_synonym: ["Pluto TV", "Pluto"], lang: "en" }] },
        { key: "starz", names: [{ name_synonym: ["Starz"], lang: "en" }] },
        { key: "showtime", names: [{ name_synonym: ["Showtime"], lang: "en" }] },
        { key: "vudu", names: [{ name_synonym: ["Vudu"], lang: "en" }] },
        { key: "rakuten", names: [{ name_synonym: ["Rakuten", "Rakuten TV"], lang: "en" }] },
    ],
    volumeMaxLevel: 100,
    volumeCanMuteAndUnmute: true,
    volumeDefaultPercentage: 30,
    levelStepSize: 5,
    commandOnlyVolume: false,
    availableChannels: [
        { key: "abc", names: ["ABC"], number: "4" },
        { key: "nbc", names: ["NBC"], number: "5" },
        { key: "cbs", names: ["CBS"], number: "7" },
        { key: "fox", names: ["FOX"], number: "11" },
        { key: "espn", names: ["ESPN"], number: "30" },
        { key: "hbo", names: ["HBO"], number: "200" },
        { key: "cnn", names: ["CNN"], number: "100" },
        { key: "discovery", names: ["Discovery"], number: "150" },
        { key: "history", names: ["History", "History Channel"], number: "151" },
        { key: "mtv", names: ["MTV"], number: "160" },
        { key: "amc", names: ["AMC"], number: "170" },
        { key: "comedy", names: ["Comedy Central"], number: "180" },
    ],
    commandOnlyChannels: false,
    availableInputs: [
        { key: "hdmi1", names: [{ name_synonym: ["HDMI 1", "HDMI one"], lang: "en" }] },
        { key: "hdmi2", names: [{ name_synonym: ["HDMI 2", "HDMI two", "Xbox"], lang: "en" }] },
        { key: "hdmi3", names: [{ name_synonym: ["HDMI 3", "HDMI three", "PlayStation"], lang: "en" }] },
        { key: "hdmi4", names: [{ name_synonym: ["HDMI 4", "HDMI four", "Chromecast"], lang: "en" }] },
        { key: "antenna", names: [{ name_synonym: ["TV", "Antenna", "Cable", "Broadcast"], lang: "en" }] },
    ],
    orderedInputs: true,
    commandOnlyInputSelector: false,
    commandOnlyBrightness: false,
    availableModes: [
        {
            name: "picture",
            name_values: [{ name_synonym: ["picture mode", "video mode", "display mode"], lang: "en" }],
            settings: [
                { setting_name: "movie", setting_values: [{ setting_synonym: ["movie", "cinema", "film"], lang: "en" }] },
                { setting_name: "sports", setting_values: [{ setting_synonym: ["sports"], lang: "en" }] },
                { setting_name: "game", setting_values: [{ setting_synonym: ["game", "gaming"], lang: "en" }] },
                { setting_name: "vivid", setting_values: [{ setting_synonym: ["vivid", "bright"], lang: "en" }] },
                { setting_name: "standard", setting_values: [{ setting_synonym: ["standard", "default", "normal"], lang: "en" }] },
                { setting_name: "dark", setting_values: [{ setting_synonym: ["dark", "night"], lang: "en" }] },
            ],
            ordered: false,
        },
        {
            name: "sound",
            name_values: [{ name_synonym: ["sound mode", "audio mode"], lang: "en" }],
            settings: [
                { setting_name: "movie", setting_values: [{ setting_synonym: ["movie", "cinema"], lang: "en" }] },
                { setting_name: "music", setting_values: [{ setting_synonym: ["music"], lang: "en" }] },
                { setting_name: "dialog", setting_values: [{ setting_synonym: ["dialog", "voice", "speech"], lang: "en" }] },
                { setting_name: "night", setting_values: [{ setting_synonym: ["night", "quiet"], lang: "en" }] },
                { setting_name: "sports", setting_values: [{ setting_synonym: ["sports", "stadium"], lang: "en" }] },
            ],
            ordered: false,
        },
    ],
    commandOnlyModes: false,
    availableToggles: [
        {
            name: "captions",
            name_values: [{ name_synonym: ["captions", "subtitles", "closed captions", "CC"], lang: "en" }],
        },
        {
            name: "night_mode",
            name_values: [{ name_synonym: ["night mode", "dark mode"], lang: "en" }],
        },
        {
            name: "game_mode",
            name_values: [{ name_synonym: ["game mode", "gaming mode"], lang: "en" }],
        },
    ],
    commandOnlyToggles: false,
};

const DEFAULT_DEVICES: Device[] = [
    {
        id: "tv-1",
        type: "action.devices.types.TV",
        traits: MEDIA_TRAITS,
        name: {
            name: "TV",
            nicknames: ["Living Room TV", "the TV", "big screen"],
            defaultNames: ["heygoogle TV"],
        },
        willReportState: false,
        attributes: SHARED_MEDIA_ATTRIBUTES,
    },
    {
        id: "streamingbox-1",
        type: "action.devices.types.STREAMING_BOX",
        traits: MEDIA_TRAITS,
        name: {
            name: "Streaming Box",
            nicknames: ["the streamer", "the box", "Chromecast"],
            defaultNames: ["heygoogle Streaming Box"],
        },
        willReportState: false,
        attributes: SHARED_MEDIA_ATTRIBUTES,
    },
    {
        id: "remote-1",
        type: "action.devices.types.REMOTECONTROL",
        traits: MEDIA_TRAITS,
        name: {
            name: "Remote",
            nicknames: ["the remote", "media remote", "universal remote"],
            defaultNames: ["heygoogle Remote"],
        },
        willReportState: false,
        attributes: SHARED_MEDIA_ATTRIBUTES,
    },
    {
        id: "speaker-1",
        type: "action.devices.types.SPEAKER",
        traits: [
            "action.devices.traits.OnOff",
            "action.devices.traits.TransportControl",
            "action.devices.traits.MediaState",
            "action.devices.traits.AppSelector",
            "action.devices.traits.Volume",
            "action.devices.traits.Modes",
            "action.devices.traits.Toggles",
        ],
        name: {
            name: "Speaker",
            nicknames: ["the speaker", "the soundbar"],
            defaultNames: ["heygoogle Speaker"],
        },
        willReportState: false,
        attributes: SHARED_MEDIA_ATTRIBUTES,
    },
    {
        id: "avr-1",
        type: "action.devices.types.AUDIO_VIDEO_RECEIVER",
        traits: MEDIA_TRAITS,
        name: {
            name: "Receiver",
            nicknames: ["the receiver", "AV receiver", "amplifier"],
            defaultNames: ["heygoogle AVR"],
        },
        willReportState: false,
        attributes: SHARED_MEDIA_ATTRIBUTES,
    },
    {
        id: "settop-1",
        type: "action.devices.types.SETTOP",
        traits: MEDIA_TRAITS,
        name: {
            name: "Cable Box",
            nicknames: ["the cable box", "set top box"],
            defaultNames: ["heygoogle Set-Top"],
        },
        willReportState: false,
        attributes: SHARED_MEDIA_ATTRIBUTES,
    },
];

export function loadDevices(): Device[] {
    return readJSON<Device[]>(DEVICES_PATH, DEFAULT_DEVICES);
}
