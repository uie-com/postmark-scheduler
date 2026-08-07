import { completeProgressRun, createProgressRun, getProgressSnapshot, scopeProgressRun } from "@/domain/progress";
import { runTestEmails, workerHttpStatus } from "@/domain/worker";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Run the test worker directly; /ping uses the same function. */
export async function GET() {
    const runId = createProgressRun("Standalone test send queued");
    scopeProgressRun(runId, "testEmails");
    const worker = await runTestEmails({ runId });
    completeProgressRun(runId, `Standalone test send ${worker.state}`);
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
