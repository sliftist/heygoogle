function ts() {
    return new Date().toISOString();
}

export function log(tag: string, msg: string, data?: unknown) {
    let line = `${ts()} [${tag}] ${msg}`;
    if (data !== undefined) line += ` ${JSON.stringify(data)}`;
    console.log(line);
}

export function logErr(tag: string, msg: string, err: unknown) {
    const detail = err && (err as Error).message || err;
    console.error(`${ts()} [${tag}] ${msg}: ${detail}`);
}
