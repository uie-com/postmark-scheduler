import { getProgressSnapshot } from "@/domain/progress";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = {
    "Cache-Control": "no-store, max-age=0",
};

export async function GET(request: NextRequest) {
    const runId = request.nextUrl.searchParams.get("runId") ?? undefined;
    const snapshot = getProgressSnapshot(runId);

    if (runId && !snapshot) {
        return NextResponse.json(
            { ephemeral: true, error: "Progress run not found", runId },
            { status: 404, headers: noStoreHeaders },
        );
    }

    return NextResponse.json(snapshot, { status: 200, headers: noStoreHeaders });
}
