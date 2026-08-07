import { completeProgressRun, createProgressRun, getProgressSnapshot, scopeProgressRun } from "@/domain/progress";
import { runUpdateMetadata, workerHttpStatus } from "@/domain/worker";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Run the metadata worker directly; /ping uses the same function. */
export async function GET() {
    const runId = createProgressRun("Standalone metadata run queued");
    scopeProgressRun(runId, "metadata");
    const worker = await runUpdateMetadata({ runId });
    completeProgressRun(runId, `Standalone metadata run ${worker.state}`);
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
