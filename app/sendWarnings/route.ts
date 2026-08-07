import { completeProgressRun, createProgressRun, getProgressSnapshot, scopeProgressRun } from "@/domain/progress";
import { runSendWarnings, workerHttpStatus } from "@/domain/worker";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Run both warning categories directly; /ping uses the same function. */
export async function GET() {
    const runId = createProgressRun("Standalone warning run queued");
    scopeProgressRun(runId, "warnings");
    const worker = await runSendWarnings({ runId });
    completeProgressRun(runId, `Standalone warning run ${worker.state}`);
    const snapshot = getProgressSnapshot(runId);

    return NextResponse.json(
        {
            ephemeral: true,
            runId,
            state: worker.state,
            worker,
            snapshot,
        },
        { status: workerHttpStatus(worker.state) },
    );
}
