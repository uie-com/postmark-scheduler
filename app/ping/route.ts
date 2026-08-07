import { createProgressRun, completeProgressRun, getProgressSnapshot, setProgressWorker } from "@/domain/progress";
import { runSendEmails, runSendWarnings, runTestEmails, runUpdateMetadata } from "@/domain/worker";
import { logError } from "@/domain/error";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

let pingPending = false;

function aggregateStatus(states: string[]): "succeeded" | "partial" | "failed" | "busy" {
    if (states.every((state) => state === "succeeded")) {
        return "succeeded";
    }
    if (states.every((state) => state === "failed")) {
        return "failed";
    }
    if (states.some((state) => state === "busy")) {
        return "busy";
    }
    return "partial";
}

function httpStatus(state: ReturnType<typeof aggregateStatus>): number {
    switch (state) {
        case "succeeded":
            return 200;
        case "busy":
            return 429;
        case "failed":
            return 500;
        default:
            return 207;
    }
}

export async function GET() {
    if (pingPending) {
        return NextResponse.json({ message: "Ping already running" }, { status: 429 });
    }

    pingPending = true;
    try {
        const runId = createProgressRun("Ping run queued");
        const workSettled = await Promise.allSettled([
            runUpdateMetadata({ runId }),
            runTestEmails({ runId }),
            runSendEmails({ runId }),
        ]);
        // Evaluate lateness after the send worker has claimed or finalized its
        // rows so this run cannot warn about work it just completed.
        const warningsSettled = await Promise.allSettled([
            runSendWarnings({ runId }),
        ]);
        const settled = [...workSettled, ...warningsSettled];

        const workers = settled.map((entry, index) => {
            if (entry.status === "fulfilled") {
                return entry.value;
            }
            const names = ["metadata", "testEmails", "sendEmails", "warnings"] as const;
            const failure = logError(`${names[index]} worker rejection`, entry.reason);
            setProgressWorker(runId, names[index], "failed", `Worker rejected: ${failure.description}`);
            return {
                worker: names[index],
                runId,
                state: "failed" as const,
                processed: 0,
                succeeded: 0,
                failed: 1,
                message: "Worker rejected before returning a result",
                errors: [failure],
            };
        });
        const state = aggregateStatus(workers.map((worker) => worker.state));
        completeProgressRun(runId, `Ping run ${state}`);
        const snapshot = getProgressSnapshot(runId);
        return NextResponse.json(
            {
                ephemeral: true,
                runId,
                state,
                workers,
                snapshot,
            },
            { status: httpStatus(state) },
        );
    } finally {
        pingPending = false;
    }
}
