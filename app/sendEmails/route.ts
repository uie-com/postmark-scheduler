import { completeProgressRun, createProgressRun, getProgressSnapshot, scopeProgressRun } from "@/domain/progress";
import { runSendEmails, workerHttpStatus } from "@/domain/worker";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Run the production worker directly; /ping uses the same function. */
export async function GET() {
    const runId = createProgressRun("Standalone production send queued");
    scopeProgressRun(runId, "sendEmails");
    const worker = await runSendEmails({ runId });
    completeProgressRun(runId, `Standalone production send ${worker.state}`);
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
