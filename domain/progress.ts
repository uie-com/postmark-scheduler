import { randomUUID } from "node:crypto";

/**
 * Progress is intentionally an operational convenience, not a queue or a
 * source of truth. The process-local store is bounded and can disappear on a
 * restart; Airtable remains authoritative for email state.
 */

export const PROGRESS_WORKERS = [
    "metadata",
    "testEmails",
    "sendEmails",
    "warnings",
] as const;

export type ProgressWorker = (typeof PROGRESS_WORKERS)[number];
export type ProgressState =
    | "queued"
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "busy";

export type ProgressEvent = {
    at: string;
    worker?: ProgressWorker;
    level: "info" | "warning" | "error";
    message: string;
};

export type ProgressWorkerSnapshot = {
    state: ProgressState;
    startedAt?: string;
    endedAt?: string;
};

export type ProgressRunSnapshot = {
    ephemeral: true;
    runId: string;
    state: ProgressState;
    createdAt: string;
    updatedAt: string;
    workers: Record<ProgressWorker, ProgressWorkerSnapshot>;
    events: ProgressEvent[];
};

export type ProgressCollectionSnapshot = {
    ephemeral: true;
    runs: ProgressRunSnapshot[];
};

const MAX_RUNS = 25;
const MAX_EVENTS_PER_RUN = 200;
const MAX_MESSAGE_LENGTH = 240;

type MutableProgressRun = {
    ephemeral: true;
    runId: string;
    state: ProgressState;
    createdAt: string;
    updatedAt: string;
    workers: Record<ProgressWorker, ProgressWorkerSnapshot>;
    events: ProgressEvent[];
};

const runs = new Map<string, MutableProgressRun>();

function timestamp(): string {
    return new Date().toISOString();
}

function sanitizeMessage(message: string): string {
    const normalized = String(message)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\b(Bearer\s+|(?:api[-_]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[redacted]")
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return "Progress event";
    }

    return normalized.length > MAX_MESSAGE_LENGTH
        ? `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
        : normalized;
}

function emptyWorkers(): Record<ProgressWorker, ProgressWorkerSnapshot> {
    return Object.fromEntries(
        PROGRESS_WORKERS.map((worker) => [worker, { state: "queued" as const }]),
    ) as Record<ProgressWorker, ProgressWorkerSnapshot>;
}

function cloneRun(run: MutableProgressRun): ProgressRunSnapshot {
    return {
        ephemeral: true,
        runId: run.runId,
        state: run.state,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        workers: Object.fromEntries(
            PROGRESS_WORKERS.map((worker) => [worker, { ...run.workers[worker] }]),
        ) as Record<ProgressWorker, ProgressWorkerSnapshot>,
        events: run.events.map((event) => ({ ...event })),
    };
}

function pruneRuns(): void {
    while (runs.size > MAX_RUNS) {
        const oldest = runs.keys().next().value as string | undefined;
        if (!oldest) {
            return;
        }
        runs.delete(oldest);
    }
}

function deriveRunState(run: MutableProgressRun): ProgressState {
    const states = PROGRESS_WORKERS.map((worker) => run.workers[worker].state);

    if (states.some((state) => state === "running")) {
        return "running";
    }
    if (states.some((state) => state === "queued")) {
        return "queued";
    }
    if (states.some((state) => state === "busy")) {
        return "busy";
    }
    if (states.every((state) => state === "succeeded")) {
        return "succeeded";
    }
    if (states.every((state) => state === "failed")) {
        return "failed";
    }
    return "partial";
}

function appendEvent(
    run: MutableProgressRun,
    worker: ProgressWorker | undefined,
    message: string,
    level: ProgressEvent["level"] = "info",
): void {
    run.events.push({
        at: timestamp(),
        ...(worker ? { worker } : {}),
        level,
        message: sanitizeMessage(message),
    });
    if (run.events.length > MAX_EVENTS_PER_RUN) {
        run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN);
    }
    run.updatedAt = timestamp();
}

function getRun(runId: string): MutableProgressRun | undefined {
    return runs.get(runId);
}

export function createProgressRun(message = "Run queued"): string {
    const now = timestamp();
    const run: MutableProgressRun = {
        ephemeral: true,
        runId: randomUUID(),
        state: "queued",
        createdAt: now,
        updatedAt: now,
        workers: emptyWorkers(),
        events: [],
    };
    runs.set(run.runId, run);
    appendEvent(run, undefined, message);
    pruneRuns();
    return run.runId;
}

/**
 * Mark workers outside a standalone route's scope as intentionally absent so
 * that a completed single-worker run does not remain queued forever.
 */
export function scopeProgressRun(runId: string, activeWorker: ProgressWorker): void {
    const run = getRun(runId);
    if (!run) {
        return;
    }

    for (const worker of PROGRESS_WORKERS) {
        if (worker === activeWorker || run.workers[worker].state !== "queued") {
            continue;
        }
        run.workers[worker] = {
            state: "succeeded",
            endedAt: timestamp(),
        };
        appendEvent(run, worker, "Not part of this standalone run");
    }
    run.state = deriveRunState(run);
}

export function setProgressWorker(
    runId: string,
    worker: ProgressWorker,
    state: ProgressState,
    message?: string,
    level: ProgressEvent["level"] = state === "failed" ? "error" : state === "partial" || state === "busy" ? "warning" : "info",
): void {
    const run = getRun(runId);
    if (!run) {
        return;
    }

    const now = timestamp();
    const current = run.workers[worker];
    run.workers[worker] = {
        state,
        ...(state === "running" ? { startedAt: current.startedAt ?? now } : { startedAt: current.startedAt }),
        ...(state === "succeeded" || state === "partial" || state === "failed" || state === "busy"
            ? { endedAt: now }
            : { endedAt: current.endedAt }),
    };
    run.state = deriveRunState(run);
    run.updatedAt = now;
    if (message) {
        appendEvent(run, worker, message, level);
    }
}

export function addProgressEvent(
    runId: string,
    worker: ProgressWorker | undefined,
    message: string,
    level: ProgressEvent["level"] = "info",
): void {
    const run = getRun(runId);
    if (!run) {
        return;
    }
    appendEvent(run, worker, message, level);
}

export function completeProgressRun(runId: string, message = "Run complete"): void {
    const run = getRun(runId);
    if (!run) {
        return;
    }
    run.state = deriveRunState(run);
    appendEvent(run, undefined, message);
}

export function getProgressSnapshot(runId?: string): ProgressRunSnapshot | ProgressCollectionSnapshot | null {
    if (runId) {
        const run = getRun(runId);
        return run ? cloneRun(run) : null;
    }

    return {
        ephemeral: true,
        runs: Array.from(runs.values()).reverse().map(cloneRun),
    };
}

/** Test-only reset; production callers should never need to clear progress. */
export function clearProgressForTests(): void {
    runs.clear();
}
