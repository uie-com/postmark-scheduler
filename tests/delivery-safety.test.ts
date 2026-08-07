import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
    clearConfigCacheForTests,
    normalizeActiveCampaignBaseUrl,
} from "../domain/config";
import {
    fillContentVariables,
    parseTemplateContent,
} from "../domain/actions/activecampaign";
import { isWarningDue } from "../domain/actions/airtable";
import {
    sendBatchEmailOnce,
    type PostmarkBatchReport,
} from "../domain/actions/postmark";
import {
    addProgressEvent,
    clearProgressForTests,
    createProgressRun,
    getProgressSnapshot,
    setProgressWorker,
} from "../domain/progress";
import { WARNING_COOLDOWN_MS } from "../domain/settings";
import type { PostmarkEmail } from "../domain/types";

const configKeys = [
    "APP_URL",
    "SLACK_WEBHOOK_URL",
    "AIRTABLE_API_KEY",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_ID",
    "ACTIVECAMPAIGN_API_KEY",
    "ACTIVECAMPAIGN_API_URL",
    "POSTMARK_API_KEY",
] as const;

const originalEnvironment = new Map(
    configKeys.map((key) => [key, process.env[key]]),
);
const originalFetch = globalThis.fetch;

function setValidEnvironment(): void {
    Object.assign(process.env, {
        APP_URL: "http://localhost:5555",
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/test",
        AIRTABLE_API_KEY: "test-airtable-key",
        AIRTABLE_BASE_ID: "appTest",
        AIRTABLE_TABLE_ID: "tblTest",
        ACTIVECAMPAIGN_API_KEY: "test-activecampaign-key",
        ACTIVECAMPAIGN_API_URL: "https://account.example.com",
        POSTMARK_API_KEY: "test-postmark-key",
    });
    clearConfigCacheForTests();
}

function restoreEnvironment(): void {
    for (const [key, value] of originalEnvironment) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    clearConfigCacheForTests();
}

function messages(count: number): PostmarkEmail[] {
    return Array.from({ length: count }, (_, index) => ({
        From: "sender@example.com",
        To: `recipient-${index}@example.com`,
        Subject: "A test email",
        TextBody: "",
        HtmlBody: "<p>Hello</p>",
        MessageStream: "outbound",
    }));
}

function postmarkResponse(email: PostmarkEmail, errorCode = 0) {
    return {
        ErrorCode: errorCode,
        Message: errorCode === 0 ? "OK" : "Rejected",
        MessageID: `message-${email.To}`,
        SubmittedAt: "2026-08-05T12:00:00.000Z",
        To: email.To,
    };
}

function reportFor(runId: string) {
    const snapshot = getProgressSnapshot(runId);
    assert.ok(snapshot && "runId" in snapshot);
    return snapshot;
}

beforeEach(() => {
    setValidEnvironment();
    clearProgressForTests();
    globalThis.fetch = originalFetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    clearProgressForTests();
    restoreEnvironment();
});

test("normalizes ActiveCampaign roots to one API v3 base", () => {
    assert.equal(
        normalizeActiveCampaignBaseUrl("https://centercentre.api-us1.com/"),
        "https://centercentre.api-us1.com/api/3",
    );
    assert.equal(
        normalizeActiveCampaignBaseUrl("https://example.com/api/3/api/3/"),
        "https://example.com/api/3",
    );
    assert.throws(
        () => normalizeActiveCampaignBaseUrl("ftp://example.com"),
        /must use http or https/,
    );
    assert.throws(
        () => normalizeActiveCampaignBaseUrl("https://user:password@example.com"),
        /must not contain embedded credentials/,
    );
});

test("uses non-empty template content when preview content is null or blank", async () => {
    assert.equal(
        await parseTemplateContent({ id: "template-1", name: "Template", preview_content: null, content: "<p>Body</p>" }),
        "<p>Body</p>",
    );
    assert.equal(
        await parseTemplateContent({ id: "template-1", name: "Template", preview_content: "  ", content: "<p>Body</p>" }),
        "<p>Body</p>",
    );
    await assert.rejects(
        parseTemplateContent({ id: "template-1", name: "Template", preview_content: " ", content: null }),
        /template 'template-1' has no usable content/,
    );
});

test("fills variable values literally even when their names and values contain regex or replacement tokens", () => {
    const content = "%FIRST.NAME% — %A+B% — %UNKNOWN%";
    const filled = fillContentVariables(content, {
        ID: "1",
        EMAIL: "person@example.com",
        "FIRST.NAME": "$& Jane",
        "A+B": "$1 value",
    });

    assert.equal(filled, "$& Jane — $1 value — ");
});

test("warning cooldown is respected and malformed warning state is treated as due", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const recent = new Date(now.getTime() - WARNING_COOLDOWN_MS + 1).toISOString();
    const exactBoundary = new Date(now.getTime() - WARNING_COOLDOWN_MS).toISOString();

    assert.equal(isWarningDue({ "Airtable ID": "rec1", Warnings: JSON.stringify({ "Late Send": recent }) }, "Late Send", now), false);
    assert.equal(isWarningDue({ "Airtable ID": "rec1", Warnings: JSON.stringify({ "Late Send": exactBoundary }) }, "Late Send", now), true);
    assert.equal(isWarningDue({ "Airtable ID": "rec1", Warnings: "not-json" }, "Late Send", now), true);
});

test("progress snapshots retain bounded runs and events with event levels", () => {
    const runId = createProgressRun();
    addProgressEvent(runId, "sendEmails", "Watch this", "warning");
    setProgressWorker(runId, "sendEmails", "failed", "Delivery failed", "error");
    const initial = reportFor(runId);
    assert.ok(initial.events.some((event) => event.level === "warning"));
    assert.ok(initial.events.some((event) => event.level === "error"));

    for (let index = 0; index < 205; index += 1) {
        addProgressEvent(runId, "sendEmails", `event-${index}`);
    }
    assert.equal(reportFor(runId).events.length, 200);

    for (let index = 0; index < 25; index += 1) {
        createProgressRun(`run-${index}`);
    }
    const collection = getProgressSnapshot();
    assert.ok(collection && "runs" in collection);
    assert.equal(collection.runs.length, 25);
    assert.equal(getProgressSnapshot(runId), null);
});

test("splits 501 Postmark messages into 500 and 1 without resending", async () => {
    const chunkSizes: number[] = [];
    globalThis.fetch = (async (_input, init) => {
        const chunk = JSON.parse(String(init?.body)) as PostmarkEmail[];
        chunkSizes.push(chunk.length);
        return Response.json(chunk.map((email) => postmarkResponse(email)));
    }) as typeof fetch;

    const report = await sendBatchEmailOnce(messages(501));

    assert.deepEqual(chunkSizes, [500, 1]);
    assert.equal(report.outcome, "complete");
    assert.equal(report.submittedMessages, 501);
    assert.equal(report.respondedMessages, 501);
    assert.equal(report.unsubmittedMessages, 0);
});

test("does not retry a Postmark network-ambiguous request", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
        requests += 1;
        throw new Error("socket closed after request write");
    }) as typeof fetch;

    const report = await sendBatchEmailOnce(messages(1));

    assert.equal(requests, 1);
    assert.equal(report.outcome, "unknown/ambiguous");
    assert.equal(report.ambiguousMessages, 1);
    assert.equal(report.unsubmittedMessages, 0);
});

test("reports per-recipient Postmark rejection as known partial delivery", async () => {
    globalThis.fetch = (async (_input, init) => {
        const chunk = JSON.parse(String(init?.body)) as PostmarkEmail[];
        return Response.json(chunk.map((email, index) => postmarkResponse(email, index === 0 ? 0 : 406)));
    }) as typeof fetch;

    const report: PostmarkBatchReport = await sendBatchEmailOnce(messages(2));

    assert.equal(report.outcome, "rejected/partial-known");
    assert.equal(report.ambiguousMessages, 0);
    assert.equal(report.responses.length, 2);
    assert.equal(report.responses.filter((response) => response.ErrorCode === 0).length, 1);
});

test("accepts Postmark's minimal documented rejection shape as known", async () => {
    globalThis.fetch = (async () => Response.json([{
        ErrorCode: 406,
        Message: "Inactive recipient",
    }])) as typeof fetch;

    const report = await sendBatchEmailOnce(messages(1));

    assert.equal(report.outcome, "rejected/partial-known");
    assert.equal(report.ambiguousMessages, 0);
    assert.equal(report.responses.length, 1);
});

test("treats a malformed Postmark success response as ambiguous", async () => {
    globalThis.fetch = (async () => Response.json([{ ErrorCode: "not-a-number" }])) as typeof fetch;

    const report = await sendBatchEmailOnce(messages(1));

    assert.equal(report.outcome, "unknown/ambiguous");
    assert.equal(report.ambiguousMessages, 1);
    assert.equal(report.responses.length, 0);
});
