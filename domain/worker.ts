import {
    getActiveContactsInAutomation,
    getAllContactVariables,
    getAutomationDetails,
    getTemplateDetails,
    listFields,
    parseTemplateContent,
} from "./actions/activecampaign";
import {
    claimEmailForSending,
    claimEmailForTesting,
    getEmailsThatAreWaitingOnReview,
    getEmailsThatAreWaitingOnSend,
    getEmailsThatNeedMetadataUpdate,
    getScheduledEmails,
    getTestEmails,
    isWarningDue,
    markEmailAsSendFailed,
    markEmailAsSendOutcomeUnknown,
    markEmailAsSent,
    markEmailAsSentWithErrors,
    markEmailAsTestFailed,
    markEmailAsTestOutcomeUnknown,
    markEmailAsTested,
    markEmailAsTestedWithErrors,
    markWarningSent,
    saveMetadata,
    type AirtableEmail,
} from "./actions/airtable";
import { createBatchEmailArray, sendBatchEmailOnce, type PostmarkBatchReport } from "./actions/postmark";
import { sendSlackMessage } from "./actions/slack";
import { logError, notifyError, type StructuredError } from "./error";
import {
    addProgressEvent,
    setProgressWorker,
    type ProgressState,
    type ProgressWorker,
} from "./progress";
import { TEST_AUTOMATION, LATE_QA_WARNING, LATE_SEND_WARNING } from "./settings";
import type { Email, PostmarkEmail } from "./types";

export type WorkerResult = {
    worker: ProgressWorker;
    runId: string;
    state: Exclude<ProgressState, "queued" | "running">;
    processed: number;
    succeeded: number;
    failed: number;
    message: string;
    errors: StructuredError[];
};

export type WorkerOptions = {
    runId: string;
};

export function workerHttpStatus(state: WorkerResult["state"]): number {
    switch (state) {
        case "busy":
            return 429;
        case "failed":
            return 500;
        case "partial":
            return 207;
        default:
            return 200;
    }
}

const workerLocks = new Set<ProgressWorker>();

function result(
    worker: ProgressWorker,
    runId: string,
    state: WorkerResult["state"],
    processed = 0,
    succeeded = 0,
    failed = 0,
    message = "Worker complete",
    errors: StructuredError[] = [],
): WorkerResult {
    return { worker, runId, state, processed, succeeded, failed, message, errors };
}

function stateForCounts(processed: number, failed: number, succeeded: number): WorkerResult["state"] {
    if (failed === 0) {
        return "succeeded";
    }
    return succeeded > 0 || processed > failed ? "partial" : "failed";
}

function safeRecordOperation(operation: string, email: Email): string {
    return `${operation} (Airtable record ${email["Airtable ID"]})`;
}

function acceptedResponses(report: PostmarkBatchReport): number {
    return report.responses.filter((response) => response.ErrorCode === 0).length;
}

function validateBatch(emails: PostmarkEmail[], expectedCount: number): void {
    if (expectedCount < 1 || emails.length !== expectedCount) {
        throw new Error("Prepared Postmark batch did not match the active recipient count");
    }
    for (const email of emails) {
        if (typeof email.To !== "string" || email.To.trim().length === 0) {
            throw new Error("Prepared Postmark batch contains a recipient without an address");
        }
        if (typeof email.Subject !== "string" || email.Subject.trim().length === 0) {
            throw new Error("Prepared Postmark batch contains an empty subject");
        }
        if (typeof email.HtmlBody !== "string") {
            throw new Error("Prepared Postmark batch contains an invalid HTML body");
        }
    }
}

function testSubject(email: Email, testNumber: number): string {
    const date = new Date(email["Schedule Date"]);
    let dateLabel = "ASAP";
    if (!Number.isNaN(date.getTime()) && date >= new Date()) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            hour12: true,
        }).formatToParts(date);
        const month = parts.find((part) => part.type === "month")?.value ?? "?";
        const day = parts.find((part) => part.type === "day")?.value ?? "?";
        const hour = parts.find((part) => part.type === "hour")?.value ?? "?";
        const period = parts.find((part) => part.type === "dayPeriod")?.value ?? "";
        dateLabel = `${month}-${day} ${hour}${period}`;
    }
    return `TEST #${testNumber}: [${dateLabel}] ${email.Subject}`;
}

async function runLocked(
    worker: ProgressWorker,
    runId: string,
    action: () => Promise<WorkerResult>,
): Promise<WorkerResult> {
    if (workerLocks.has(worker)) {
        setProgressWorker(runId, worker, "busy", "Worker is already running in this process");
        return result(worker, runId, "busy", 0, 0, 0, "Worker is busy");
    }

    workerLocks.add(worker);
    setProgressWorker(runId, worker, "running", "Worker started");
    try {
        const completed = await action();
        setProgressWorker(runId, worker, completed.state, completed.message);
        return completed;
    } catch (error) {
        const failure = await notifyError(`${worker} worker`, error);
        const completed = result(worker, runId, "failed", 0, 0, 1, failure.description, [failure]);
        setProgressWorker(runId, worker, "failed", `Worker failed: ${failure.description}`);
        return completed;
    } finally {
        workerLocks.delete(worker);
    }
}

async function recordPreparationFailure(
    worker: ProgressWorker,
    runId: string,
    email: Email,
    operation: string,
    error: unknown,
): Promise<StructuredError> {
    const failure = await notifyError(safeRecordOperation(operation, email), error);
    addProgressEvent(
        runId,
        worker,
        `Record ${email["Airtable ID"]} failed during ${operation}: ${failure.description}`,
        "error",
    );
    return failure;
}

async function finalizeProduction(
    email: Email,
    report: PostmarkBatchReport,
): Promise<void> {
    if (report.outcome === "complete") {
        await markEmailAsSent(email["Airtable ID"]);
        return;
    }

    if (report.outcome === "unknown/ambiguous") {
        await markEmailAsSendOutcomeUnknown(email["Airtable ID"]);
        return;
    }

    if (acceptedResponses(report) > 0) {
        await markEmailAsSentWithErrors(email["Airtable ID"]);
    } else {
        await markEmailAsSendFailed(email["Airtable ID"]);
    }
}

async function finalizeTest(
    email: Email,
    testNumber: number,
    report: PostmarkBatchReport,
): Promise<void> {
    if (report.outcome === "complete") {
        await markEmailAsTested(email["Airtable ID"], testNumber);
        return;
    }

    if (report.outcome === "unknown/ambiguous") {
        await markEmailAsTestOutcomeUnknown(email["Airtable ID"]);
        return;
    }

    if (acceptedResponses(report) > 0) {
        await markEmailAsTestedWithErrors(email["Airtable ID"]);
    } else {
        await markEmailAsTestFailed(email["Airtable ID"]);
    }
}

async function reportNonCompleteOutcome(
    worker: ProgressWorker,
    runId: string,
    email: Email,
    report: PostmarkBatchReport,
): Promise<StructuredError> {
    const description = [
        `Postmark outcome ${report.outcome}`,
        `accepted ${acceptedResponses(report)}`,
        `responded ${report.respondedMessages}/${report.totalMessages}`,
        `unsubmitted ${report.unsubmittedMessages}`,
        `ambiguous ${report.ambiguousMessages}`,
        report.error ? `provider detail: ${report.error}` : undefined,
    ]
        .filter((part): part is string => Boolean(part))
        .join("; ");
    const failure = await notifyError(
        safeRecordOperation(`${worker} delivery outcome`, email),
        new Error(description),
    );
    addProgressEvent(
        runId,
        worker,
        `Record ${email["Airtable ID"]}: ${description}`,
        "warning",
    );
    return failure;
}

export async function runSendEmails({ runId }: WorkerOptions): Promise<WorkerResult> {
    return runLocked("sendEmails", runId, async () => {
        const emails = await getScheduledEmails();
        addProgressEvent(runId, "sendEmails", `Found ${emails.length} scheduled records`);
        if (emails.length === 0) {
            return result("sendEmails", runId, "succeeded", 0, 0, 0, "No records ready to send");
        }

        const fields = await listFields();
        let processed = 0;
        let succeeded = 0;
        let failed = 0;
        const errors: StructuredError[] = [];

        for (const email of emails) {
            processed += 1;
            try {
                await getAutomationDetails(email["Automation ID"]);
                const contacts = await getActiveContactsInAutomation(email["Automation ID"]);
                if (contacts.length === 0) {
                    throw new Error("No active contacts found in automation");
                }
                const template = await getTemplateDetails(email["Template ID"]);
                const content = await parseTemplateContent(template);
                const variables = await getAllContactVariables(contacts, fields);
                const batch = await createBatchEmailArray(contacts, email, content, variables);
                validateBatch(batch, contacts.length);

                // The row is claimed only after every provider-read and local
                // validation step succeeds, immediately before Postmark.
                await claimEmailForSending(email["Airtable ID"]);
                const report = await sendBatchEmailOnce(batch);
                try {
                    await finalizeProduction(email, report);
                } catch (finalizationError) {
                    const failure = await recordPreparationFailure(
                        "sendEmails",
                        runId,
                        email,
                        "finalizing send outcome (row remains Sending)",
                        finalizationError,
                    );
                    errors.push(failure);
                    failed += 1;
                    continue;
                }

                let outcomeFailure: StructuredError | undefined;
                if (report.outcome === "complete") {
                    succeeded += 1;
                } else {
                    failed += 1;
                    if (acceptedResponses(report) > 0) {
                        succeeded += 1;
                    }
                    outcomeFailure = await reportNonCompleteOutcome("sendEmails", runId, email, report);
                    errors.push(outcomeFailure);
                }
                addProgressEvent(
                    runId,
                    "sendEmails",
                    `Record ${email["Airtable ID"]} ended ${report.outcome}`,
                    report.outcome === "complete" ? "info" : "warning",
                );
            } catch (error) {
                failed += 1;
                errors.push(await recordPreparationFailure("sendEmails", runId, email, "preparing send", error));
            }
        }

        const state = stateForCounts(processed, failed, succeeded);
        return result("sendEmails", runId, state, processed, succeeded, failed, `Processed ${processed} records`, errors);
    });
}

export async function runTestEmails({ runId }: WorkerOptions): Promise<WorkerResult> {
    return runLocked("testEmails", runId, async () => {
        const emails = await getTestEmails();
        addProgressEvent(runId, "testEmails", `Found ${emails.length} test records`);
        if (emails.length === 0) {
            return result("testEmails", runId, "succeeded", 0, 0, 0, "No records ready for testing");
        }

        const fields = await listFields();
        let processed = 0;
        let succeeded = 0;
        let failed = 0;
        const errors: StructuredError[] = [];

        for (const email of emails) {
            processed += 1;
            try {
                const testNumberValue = Number(email["Test Number"]);
                const testNumber = Number.isFinite(testNumberValue) ? Math.max(0, Math.trunc(testNumberValue)) : 0;
                const testEmail = {
                    ...email,
                    "Automation ID": TEST_AUTOMATION,
                    Subject: testSubject(email, testNumber),
                };
                await getAutomationDetails(TEST_AUTOMATION);
                const contacts = await getActiveContactsInAutomation(TEST_AUTOMATION);
                if (contacts.length === 0) {
                    throw new Error("No active contacts found in test automation");
                }
                const template = await getTemplateDetails(email["Template ID"]);
                const content = await parseTemplateContent(template);
                const variables = await getAllContactVariables(contacts, fields);
                const batch = await createBatchEmailArray(contacts, testEmail, content, variables);
                validateBatch(batch, contacts.length);

                await claimEmailForTesting(email["Airtable ID"]);
                const report = await sendBatchEmailOnce(batch);
                try {
                    await finalizeTest(email, testNumber, report);
                } catch (finalizationError) {
                    const failure = await recordPreparationFailure(
                        "testEmails",
                        runId,
                        email,
                        "finalizing test outcome (row remains Testing)",
                        finalizationError,
                    );
                    errors.push(failure);
                    failed += 1;
                    continue;
                }

                let outcomeFailure: StructuredError | undefined;
                if (report.outcome === "complete") {
                    succeeded += 1;
                } else {
                    failed += 1;
                    if (acceptedResponses(report) > 0) {
                        succeeded += 1;
                    }
                    outcomeFailure = await reportNonCompleteOutcome("testEmails", runId, email, report);
                    errors.push(outcomeFailure);
                }
                addProgressEvent(
                    runId,
                    "testEmails",
                    `Record ${email["Airtable ID"]} ended ${report.outcome}`,
                    report.outcome === "complete" ? "info" : "warning",
                );
            } catch (error) {
                failed += 1;
                errors.push(await recordPreparationFailure("testEmails", runId, email, "preparing test", error));
            }
        }

        const state = stateForCounts(processed, failed, succeeded);
        return result("testEmails", runId, state, processed, succeeded, failed, `Processed ${processed} records`, errors);
    });
}

export async function runUpdateMetadata({ runId }: WorkerOptions): Promise<WorkerResult> {
    return runLocked("metadata", runId, async () => {
        const emails = await getEmailsThatNeedMetadataUpdate();
        addProgressEvent(runId, "metadata", `Found ${emails.length} metadata records`);
        let processed = 0;
        let succeeded = 0;
        let failed = 0;
        const errors: StructuredError[] = [];

        for (const email of emails) {
            processed += 1;
            try {
                const automation = await getAutomationDetails(email["Automation ID"]);
                const template = await getTemplateDetails(email["Template ID"]);
                await saveMetadata(email["Airtable ID"], automation.name, template.name);
                succeeded += 1;
                addProgressEvent(runId, "metadata", `Updated record ${email["Airtable ID"]}`);
            } catch (error) {
                failed += 1;
                errors.push(await recordPreparationFailure("metadata", runId, email, "updating metadata", error));
            }
        }

        const state = stateForCounts(processed, failed, succeeded);
        return result("metadata", runId, state, processed, succeeded, failed, `Processed ${processed} records`, errors);
    });
}

type WarningCategory = {
    name: string;
    label: string;
    emails: AirtableEmail[];
};

function warningMessage(category: WarningCategory): string {
    const ids = category.emails.slice(0, 10).map((email) => email["Airtable ID"]);
    const suffix = category.emails.length > ids.length ? ` (+${category.emails.length - ids.length} more)` : "";
    return `⚠️ ${category.label}: ${category.emails.length} Airtable records due. Records: ${ids.join(", ")}${suffix}`;
}

async function deliverWarningCategory(
    runId: string,
    category: WarningCategory,
): Promise<{ succeeded: number; failed: number; errors: StructuredError[] }> {
    if (category.emails.length === 0) {
        addProgressEvent(runId, "warnings", `${category.label}: no warning due`);
        return { succeeded: 0, failed: 0, errors: [] };
    }

    try {
        await sendSlackMessage(warningMessage(category));
    } catch (error) {
        const failure = logError(`${category.label} warning Slack delivery`, error);
        addProgressEvent(
            runId,
            "warnings",
            `${category.label}: Slack delivery failed; markers unchanged: ${failure.description}`,
            "error",
        );
        return { succeeded: 0, failed: category.emails.length, errors: [failure] };
    }

    let succeeded = 0;
    let failed = 0;
    const errors: StructuredError[] = [];
    for (const email of category.emails) {
        try {
            await markWarningSent(email, category.name);
            succeeded += 1;
        } catch (error) {
            failed += 1;
            errors.push(await recordPreparationFailure("warnings", runId, email, "persisting warning marker", error));
        }
    }
    addProgressEvent(runId, "warnings", `${category.label}: delivered ${succeeded}/${category.emails.length}`);
    return { succeeded, failed, errors };
}

export async function runSendWarnings({ runId }: WorkerOptions): Promise<WorkerResult> {
    return runLocked("warnings", runId, async () => {
        let review: AirtableEmail[] = [];
        let send: AirtableEmail[] = [];
        const errors: StructuredError[] = [];
        let queryFailures = 0;

        try {
            review = await getEmailsThatAreWaitingOnReview();
        } catch (error) {
            queryFailures += 1;
            const failure = await notifyError("loading QA warning records", error);
            errors.push(failure);
            addProgressEvent(runId, "warnings", `Late QA query failed: ${failure.description}`, "error");
        }

        try {
            send = await getEmailsThatAreWaitingOnSend();
        } catch (error) {
            queryFailures += 1;
            const failure = await notifyError("loading late-send warning records", error);
            errors.push(failure);
            addProgressEvent(runId, "warnings", `Late Send query failed: ${failure.description}`, "error");
        }

        const dueReview = review.filter((email) => isWarningDue(email, LATE_QA_WARNING));
        const dueSend = send.filter((email) => isWarningDue(email, LATE_SEND_WARNING));
        const categories: WarningCategory[] = [
            { name: LATE_QA_WARNING, label: "Late QA", emails: dueReview },
            { name: LATE_SEND_WARNING, label: "Late Send", emails: dueSend },
        ];

        let processed = dueReview.length + dueSend.length;
        let succeeded = 0;
        let failed = queryFailures;
        for (const category of categories) {
            const delivered = await deliverWarningCategory(runId, category);
            succeeded += delivered.succeeded;
            failed += delivered.failed;
            errors.push(...delivered.errors);
        }

        // A query failure represents work that could not be evaluated even if
        // no records were returned from the other category.
        processed += queryFailures;
        const state = stateForCounts(processed, failed, succeeded);
        return result("warnings", runId, state, processed, succeeded, failed, "Warning categories processed", errors);
    });
}
