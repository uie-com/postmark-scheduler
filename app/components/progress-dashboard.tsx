"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProgressCollectionSnapshot,
  ProgressEvent,
  ProgressRunSnapshot,
  ProgressState,
  ProgressWorker,
} from "@/domain/progress";

const POLL_INTERVAL_MS = 2_000;
const WORKER_ORDER: readonly ProgressWorker[] = [
  "metadata",
  "testEmails",
  "sendEmails",
  "warnings",
];

const WORKER_LABELS: Record<ProgressWorker, string> = {
  metadata: "Metadata",
  testEmails: "Test emails",
  sendEmails: "Send emails",
  warnings: "Warnings",
};

const STATE_META: Record<
  ProgressState,
  { label: string; dot: string; badge: string; bar: string }
> = {
  queued: {
    label: "Queued",
    dot: "bg-amber-400",
    badge: "border-amber-200 bg-amber-50 text-amber-800",
    bar: "bg-amber-400",
  },
  running: {
    label: "Running",
    dot: "bg-sky-500",
    badge: "border-sky-200 bg-sky-50 text-sky-800",
    bar: "bg-sky-500",
  },
  succeeded: {
    label: "Succeeded",
    dot: "bg-emerald-500",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
    bar: "bg-emerald-500",
  },
  partial: {
    label: "Partial",
    dot: "bg-orange-500",
    badge: "border-orange-200 bg-orange-50 text-orange-800",
    bar: "bg-orange-500",
  },
  failed: {
    label: "Failed",
    dot: "bg-rose-500",
    badge: "border-rose-200 bg-rose-50 text-rose-800",
    bar: "bg-rose-500",
  },
  busy: {
    label: "Busy",
    dot: "bg-violet-500",
    badge: "border-violet-200 bg-violet-50 text-violet-800",
    bar: "bg-violet-500",
  },
};

const TERMINAL_STATES: readonly ProgressState[] = [
  "succeeded",
  "partial",
  "failed",
];

type LoadState = "loading" | "ready" | "error";
type EventLevel = "info" | "warning" | "error";

const EVENT_META: Record<EventLevel, { label: string; dot: string; text: string }> = {
  info: { label: "Info", dot: "bg-slate-300", text: "text-slate-400" },
  warning: { label: "Warning", dot: "bg-amber-400", text: "text-amber-700" },
  error: { label: "Error", dot: "bg-rose-500", text: "text-rose-700" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProgressState(value: unknown): value is ProgressState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "partial" ||
    value === "failed" ||
    value === "busy"
  );
}

function isProgressWorker(value: unknown): value is ProgressWorker {
  return (
    value === "metadata" ||
    value === "testEmails" ||
    value === "sendEmails" ||
    value === "warnings"
  );
}

function isProgressEvent(value: unknown): value is ProgressEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.at === "string" &&
    typeof value.message === "string" &&
    isEventLevel(value.level)
  );
}

function isEventLevel(value: unknown): value is EventLevel {
  return value === "info" || value === "warning" || value === "error";
}

function getEventLevel(event: ProgressEvent): EventLevel {
  return event.level;
}

function isProgressRun(value: unknown): value is ProgressRunSnapshot {
  if (!isRecord(value) || value.ephemeral !== true) {
    return false;
  }

  if (
    typeof value.runId !== "string" ||
    !isProgressState(value.state) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.workers) ||
    !Array.isArray(value.events)
  ) {
    return false;
  }

  const workers = value.workers;
  const workersAreValid = WORKER_ORDER.every((worker) => {
    const workerSnapshot = workers[worker];
    return isRecord(workerSnapshot) && isProgressState(workerSnapshot.state);
  });

  return (
    workersAreValid &&
    value.events.every((event) => {
      if (!isProgressEvent(event)) {
        return false;
      }
      return event.worker === undefined || isProgressWorker(event.worker);
    })
  );
}

function isProgressCollection(value: unknown): value is ProgressCollectionSnapshot {
  return (
    isRecord(value) &&
    value.ephemeral === true &&
    Array.isArray(value.runs) &&
    value.runs.every(isProgressRun)
  );
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function shortRunId(runId: string): string {
  return runId.length > 14 ? `${runId.slice(0, 8)}…${runId.slice(-4)}` : runId;
}

function activeRun(runs: ProgressRunSnapshot[]): ProgressRunSnapshot | null {
  return (
    runs.find((run) => run.state === "running" || run.state === "queued") ??
    runs.find((run) => run.state === "busy") ??
    runs[0] ??
    null
  );
}

function completedWorkerCount(run: ProgressRunSnapshot | null): number {
  if (!run) {
    return 0;
  }

  return WORKER_ORDER.filter((worker) =>
    TERMINAL_STATES.includes(run.workers[worker]?.state),
  ).length;
}

function stateBadge(state: ProgressState): string {
  return `${STATE_META[state].badge} border`;
}

function StateBadge({ state }: { state: ProgressState }) {
  const meta = STATE_META[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${stateBadge(state)}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function WorkerCard({
  worker,
  state,
}: {
  worker: ProgressWorker;
  state: ProgressState;
}) {
  const meta = STATE_META[state];
  return (
    <li className="flex min-h-28 flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold text-slate-900">{WORKER_LABELS[worker]}</span>
        <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      </div>
      <StateBadge state={state} />
    </li>
  );
}

function EmptyState() {
  return (
    <section className="rounded-3xl border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center shadow-sm">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.7">
          <path d="M6 3.75h12v16.5H6z" />
          <path d="M9 8h6M9 12h6M9 16h3" strokeLinecap="round" />
        </svg>
      </div>
      <h2 className="mt-4 text-base font-semibold text-slate-900">No scheduler runs yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
        This page will show the next run when the scheduler is invoked. It does not start a run by itself.
      </p>
    </section>
  );
}

function LoadingState() {
  return (
    <section className="space-y-4" aria-label="Loading scheduler status" aria-busy="true">
      <div className="h-44 animate-pulse rounded-3xl bg-slate-200/70" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="h-28 animate-pulse rounded-2xl bg-slate-200/70" />
        ))}
      </div>
    </section>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section role="alert" className="rounded-3xl border border-rose-200 bg-rose-50 px-6 py-10 text-center">
      <h2 className="text-base font-semibold text-rose-900">Status is temporarily unavailable</h2>
      <p className="mt-2 text-sm leading-6 text-rose-800">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex min-h-10 items-center justify-center rounded-xl border border-rose-300 bg-white px-4 text-sm font-semibold text-rose-900 shadow-sm transition hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
      >
        Try again
      </button>
    </section>
  );
}

function RunSummary({ run }: { run: ProgressRunSnapshot }) {
  const completed = completedWorkerCount(run);
  const total = WORKER_ORDER.length;
  const percent = Math.round((completed / total) * 100);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50 sm:p-7" aria-labelledby="current-run-heading">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">{run.state === "running" || run.state === "queued" ? "Current run" : "Latest run"}</p>
          <h2 id="current-run-heading" className="mt-2 text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">
            Scheduler orchestration
          </h2>
          <p className="mt-1 font-mono text-xs text-slate-500" title={run.runId}>
            Run {shortRunId(run.runId)}
          </p>
        </div>
        <StateBadge state={run.state} />
      </div>

      <div className="mt-7 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium text-slate-700">Worker progress</span>
            <span className="font-mono text-xs text-slate-500">{completed}/{total} complete</span>
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-label={`${completed} of ${total} workers complete`}>
            <div className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${STATE_META[run.state].bar}`} style={{ width: `${percent}%` }} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:min-w-52">
          <div>
            <dt className="text-slate-500">Started</dt>
            <dd className="mt-0.5 font-medium text-slate-800">{formatDate(run.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Updated</dt>
            <dd className="mt-0.5 font-medium text-slate-800">{formatDate(run.updatedAt)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function EventsPanel({ run }: { run: ProgressRunSnapshot | null }) {
  const events = run?.events.slice(-8).reverse() ?? [];

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50 sm:p-6" aria-labelledby="events-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="events-heading" className="text-base font-semibold text-slate-950">Recent activity</h2>
        <span className="text-xs font-medium text-slate-500">Safe operational log</span>
      </div>
      {events.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No events recorded for this run.</p>
      ) : (
        <ol className="mt-4 divide-y divide-slate-100">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="flex gap-3 py-3 first:pt-0 last:pb-0">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${EVENT_META[getEventLevel(event)].dot}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm leading-5 text-slate-700">{event.message}</p>
                <p className={`mt-1 text-xs ${EVENT_META[getEventLevel(event)].text}`}>
                  {EVENT_META[getEventLevel(event)].label} · {event.worker ? `${WORKER_LABELS[event.worker]} · ` : ""}{formatTime(event.at)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RecentRuns({ runs }: { runs: ProgressRunSnapshot[] }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50 sm:p-6" aria-labelledby="runs-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="runs-heading" className="text-base font-semibold text-slate-950">Recent runs</h2>
        <span className="text-xs font-medium text-slate-500">Newest first</span>
      </div>
      {runs.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No recent runs.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {runs.slice(0, 8).map((run) => (
            <li key={run.runId} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-mono text-xs text-slate-600" title={run.runId}>{shortRunId(run.runId)}</p>
                <p className="mt-1 text-xs text-slate-400">{formatDate(run.createdAt)}</p>
              </div>
              <StateBadge state={run.state} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ProgressDashboard() {
  const [snapshot, setSnapshot] = useState<ProgressCollectionSnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/progress", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        throw new Error(`The progress endpoint returned ${response.status}.`);
      }

      const payload: unknown = await response.json();
      if (!isProgressCollection(payload)) {
        throw new Error("The progress endpoint returned an unexpected snapshot.");
      }

      if (!signal?.aborted) {
        setSnapshot(payload);
        setLoadState("ready");
        setErrorMessage(null);
        setLastUpdated(new Date().toISOString());
      }
    } catch (error: unknown) {
      if (signal?.aborted) {
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : "Unable to load scheduler progress.");
      setLoadState((current) => (current === "ready" ? current : "error"));
    } finally {
      if (!signal?.aborted) {
        setIsRefreshing(false);
      }
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => {
      void refresh(controller.signal);
    }, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  const runs = snapshot?.runs ?? [];
  const run = useMemo(() => activeRun(runs), [runs]);
  const workerStates = run?.workers;

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        <header className="flex flex-col gap-6 border-b border-slate-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
                Scheduler monitor
              </span>
              <span className="text-xs font-medium text-slate-500">Live · refreshes every 2 seconds</span>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Run progress</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
              A lightweight view of the latest orchestration run and its workers.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isRefreshing}
            className="inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60 sm:self-auto"
          >
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${isRefreshing ? "animate-spin motion-reduce:animate-none" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M20 11a8 8 0 0 0-14.7-4L4 9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 4v5h5M4 13a8 8 0 0 0 14.7 4L20 15" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 20v-5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>Operational snapshot only</span>
            {lastUpdated ? <span>· Updated {formatTime(lastUpdated)}</span> : null}
          </div>
          {errorMessage && loadState === "ready" ? (
            <div role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Showing the last known snapshot. {errorMessage}
            </div>
          ) : null}
        </div>

        <div className="mt-6 space-y-6">
          {loadState === "loading" ? <LoadingState /> : null}
          {loadState === "error" ? <ErrorState message={errorMessage ?? "Unable to load scheduler progress."} onRetry={() => void refresh()} /> : null}
          {loadState === "ready" && !run ? <EmptyState /> : null}
          {loadState === "ready" && run ? (
            <>
              <RunSummary run={run} />

              <section aria-labelledby="workers-heading">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h2 id="workers-heading" className="text-base font-semibold text-slate-950">Workers</h2>
                    <p className="mt-1 text-sm text-slate-600">Each worker reports its own in-memory state.</p>
                  </div>
                  <span className="hidden text-xs text-slate-500 sm:block">No delivery data is changed here</span>
                </div>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {WORKER_ORDER.map((worker) => (
                    <WorkerCard key={worker} worker={worker} state={workerStates?.[worker]?.state ?? "queued"} />
                  ))}
                </ul>
              </section>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
                <EventsPanel run={run} />
                <RecentRuns runs={runs} />
              </div>
            </>
          ) : null}
        </div>

        <footer className="mt-10 rounded-2xl border border-slate-200 bg-white/70 px-4 py-4 text-sm leading-6 text-slate-600 shadow-sm sm:px-5">
          <span className="font-semibold text-slate-800">Ephemeral operational view.</span>{" "}
          This process-local snapshot can disappear after a restart and is not authoritative. Airtable remains the durable source of delivery state.
        </footer>
      </div>
    </main>
  );
}
