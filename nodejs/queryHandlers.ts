export type QueryStateConfig = {
    userId: string;
    deviceId: string;
};

const APPLICATION_MESSAGES = [
    "build is green, 42 passing zero failing",
    "deploy queue is empty",
    "you have 12 pull requests awaiting review",
    "all systems nominal, no alerts",
    "your next standup is in 47 minutes",
    "weekly burn rate, 18 hours under budget",
    "last commit was 12 minutes ago by you",
];

const CHANNEL_NAME_MESSAGES = [
    "production CPU at 34 percent",
    "no incidents in the past 7 days",
    "uptime 14 days 3 hours",
    "memory holding at 62 percent",
    "request latency under 50 milliseconds",
    "API error rate is point oh two percent",
    "redis queue depth is 4",
];

const PICTURE_MODE_TEXT = [
    "deep work focus",
    "afternoon coasting",
    "morning sprint",
    "post lunch slump",
    "evening wind down",
];

const SOUND_MODE_TEXT = [
    "quiet cinema",
    "loud and proud",
    "midnight whispers",
    "open office din",
];

function rotating<T>(arr: T[], windowMs = 30_000): T {
    return arr[Math.floor(Date.now() / windowMs) % arr.length];
}

export function getQueryState(config: QueryStateConfig): Record<string, unknown> {
    return {
        online: true,
        status: "SUCCESS",
        on: true,
        currentApplication: rotating(APPLICATION_MESSAGES),
        playbackState: "PAUSED",
        activityState: "STANDBY",
        currentVolume: 30,
        isMuted: false,
        currentInput: "hdmi1",
        brightness: 80,
        currentModeSettings: {
            picture: rotating(PICTURE_MODE_TEXT),
            sound: rotating(SOUND_MODE_TEXT),
        },
        currentToggleSettings: {
            captions: false,
            night_mode: false,
            game_mode: false,
        },
        channelNumber: String(1 + (Math.floor(Date.now() / 30_000) % 99)),
        channelName: rotating(CHANNEL_NAME_MESSAGES),
    };
}

export function getExecuteAckState(): Record<string, unknown> {
    return {
        online: true,
        status: "SUCCESS",
    };
}
