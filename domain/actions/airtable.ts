import {
    fetchAllAirtableRecords,
    updateAirtableRecord,
} from "../api/airtable";
import type { AirtableSparseFields } from "../api/airtable";
import { getConfig } from "../config";
import {
    DRAFT_STATUS,
    READY_TO_SEND_STATUS,
    READY_TO_TEST_STATUS,
    SEND_FAILED_STATUS,
    SEND_OUTCOME_UNKNOWN_STATUS,
    SENT_STATUS,
    SENT_WITH_ERRORS_STATUS,
    SENDING_STATUS,
    TEST_FAILED_STATUS,
    TEST_OUTCOME_UNKNOWN_STATUS,
    TEST_WITH_ERRORS_STATUS,
    TESTING_STATUS,
    TESTED_STATUS,
    WARNING_COOLDOWN_MS,
} from "../settings";
import type { AirtableRecord, Email } from "../types";

type AirtableEmailFields = AirtableSparseFields;

/** The known optional fields that are useful to warning and metadata callers. */
export type AirtableEmail = Email & {
    Warnings: string;
    "Email Last Modified": string;
    "Metadata Last Populated": string;
    "Automation Name": string;
    "Template Name": string;
};

/** A warning-aware shape accepted by the pure warning helpers. */
export type WarningEmail = Pick<Email, "Airtable ID"> &
    Partial<Email> & {
        Warnings?: unknown;
    };

type WarningState = Record<string, string>;

function airtableLocation(): { baseId: string; tableId: string } {
    const { airtable } = getConfig();
    return {
        baseId: airtable.baseId,
        tableId: airtable.tableId,
    };
}

function readText(fields: AirtableEmailFields, fieldName: string): string {
    const value = fields[fieldName];
    return typeof value === "string" ? value : "";
}

function readNumber(fields: AirtableEmailFields, fieldName: string): number {
    const value = fields[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return 0;
}

function warningStateFromEmail(email: WarningEmail, reportCorruption: boolean): WarningState {
    return parseWarningState(email.Warnings, email["Airtable ID"], reportCorruption);
}

function parseWarningState(
    raw: unknown,
    recordId: string | undefined,
    reportCorruption: boolean,
): WarningState {
    if (raw === undefined || raw === null || raw === "") {
        return Object.create(null) as WarningState;
    }

    let parsed: unknown;
    try {
        if (typeof raw !== "string") {
            throw new Error("Warnings is not text");
        }
        parsed = JSON.parse(raw);
    } catch {
        if (reportCorruption) {
            warnAboutCorruptWarnings(recordId);
        }
        return Object.create(null) as WarningState;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        if (reportCorruption) {
            warnAboutCorruptWarnings(recordId);
        }
        return Object.create(null) as WarningState;
    }

    const state = Object.create(null) as WarningState;
    let ignoredEntry = false;
    for (const [warningName, timestamp] of Object.entries(parsed)) {
        if (
            warningName.trim().length === 0 ||
            typeof timestamp !== "string" ||
            Number.isNaN(Date.parse(timestamp))
        ) {
            ignoredEntry = true;
            continue;
        }

        state[warningName] = timestamp;
    }

    if (ignoredEntry && reportCorruption) {
        warnAboutCorruptWarnings(recordId);
    }

    return state;
}

function warnAboutCorruptWarnings(recordId: string | undefined): void {
    const suffix = recordId ? ` for Airtable record '${recordId}'` : "";
    console.warn(`[AIRTABLE] Ignoring corrupt Warnings state${suffix}.`);
}

function normalizeEmail(record: AirtableRecord<AirtableEmailFields>): AirtableEmail {
    const fields = record.fields;
    const rawWarnings = readText(fields, "Warnings");

    // Parse once at the boundary so malformed values are treated as empty and
    // callers never receive an untrusted, legacy comma-separated marker.
    const warningState = parseWarningState(rawWarnings, record.id, true);
    const warnings = JSON.stringify(warningState);

    return {
        "Airtable ID": record.id,
        "Email ID": readText(fields, "Email ID"),
        "Template ID": readText(fields, "Template ID"),
        "Schedule Date": readText(fields, "Schedule Date"),
        "Automation ID": readText(fields, "Automation ID"),
        Status: readText(fields, "Status"),
        Subject: readText(fields, "Subject"),
        "Last Modified": readText(fields, "Email Last Modified"),
        "Sent At": readText(fields, "Sent At"),
        "Email Tag": readText(fields, "Email Tag"),
        "Test Number": readNumber(fields, "Test Number"),
        Warnings: warnings,
        "Email Last Modified": readText(fields, "Email Last Modified"),
        "Metadata Last Populated": readText(fields, "Metadata Last Populated"),
        "Automation Name": readText(fields, "Automation Name"),
        "Template Name": readText(fields, "Template Name"),
    };
}

async function listEmails(params: Record<string, string> = {}): Promise<AirtableEmail[]> {
    const { baseId, tableId } = airtableLocation();
    const records = await fetchAllAirtableRecords(baseId, tableId, params);
    return records.map(normalizeEmail);
}

async function updateEmail(emailId: string, fields: AirtableEmailFields): Promise<void> {
    const { baseId, tableId } = airtableLocation();
    await updateAirtableRecord(baseId, tableId, emailId, fields);
}

export async function getScheduledEmails(): Promise<AirtableEmail[]> {
    return listEmails({
        filterByFormula: `AND({Status} = '${READY_TO_SEND_STATUS}', {Schedule Date} <= DATEADD(NOW(), 1, 'minute'), {Sent At} = '')`,
    });
}

export async function getTestEmails(): Promise<AirtableEmail[]> {
    return listEmails({
        filterByFormula: `{Status} = '${READY_TO_TEST_STATUS}'`,
    });
}

export async function markEmailAsTested(emailId: string, testNumber: number): Promise<void> {
    const currentTestNumber = Number.isFinite(testNumber) ? Math.max(0, Math.trunc(testNumber)) : 0;
    await updateEmail(emailId, {
        Status: TESTED_STATUS,
        "Test Number": currentTestNumber + 1,
        "Tested At": new Date().toISOString(),
    });
}

/** Claim a row before any test delivery provider side effect is attempted. */
export async function claimEmailForTesting(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: TESTING_STATUS });
}

export async function markEmailAsTestedWithErrors(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: TEST_WITH_ERRORS_STATUS });
}

export async function markEmailAsTestFailed(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: TEST_FAILED_STATUS });
}

export async function markEmailAsTestOutcomeUnknown(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: TEST_OUTCOME_UNKNOWN_STATUS });
}

/** Claim a ready row before any provider side effect is attempted. */
export async function claimEmailForSending(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: SENDING_STATUS });
}

export async function markEmailAsSent(emailId: string): Promise<void> {
    await updateEmail(emailId, {
        Status: SENT_STATUS,
        "Sent At": new Date().toISOString(),
    });
}

export async function markEmailAsSentWithErrors(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: SENT_WITH_ERRORS_STATUS });
}

export async function markEmailAsSendFailed(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: SEND_FAILED_STATUS });
}

export async function markEmailAsSendOutcomeUnknown(emailId: string): Promise<void> {
    await updateEmail(emailId, { Status: SEND_OUTCOME_UNKNOWN_STATUS });
}

export async function getEmailsThatNeedMetadataUpdate(): Promise<AirtableEmail[]> {
    return listEmails({
        filterByFormula: `AND({Status} != '${DRAFT_STATUS}', {Status} != '${SENT_STATUS}', OR(IS_AFTER({Email Last Modified}, {Metadata Last Populated}), {Metadata Last Populated} = BLANK()))`,
    });
}

export async function saveMetadata(
    emailId: string,
    automationName: string,
    templateName: string,
): Promise<void> {
    await updateEmail(emailId, {
        "Automation Name": automationName,
        "Template Name": templateName,
    });
}

export async function getEmailsThatAreWaitingOnReview(): Promise<AirtableEmail[]> {
    return listEmails({
        filterByFormula: `AND({Status} = '${TESTED_STATUS}', {Schedule Date} <= DATEADD(NOW(), 1, 'minute'))`,
    });
}

export async function getEmailsThatAreWaitingOnSend(): Promise<AirtableEmail[]> {
    return listEmails({
        filterByFormula: `AND({Status} = '${READY_TO_SEND_STATUS}', {Schedule Date} <= DATEADD(NOW(), 1, 'minute'), {Sent At} = '')`,
    });
}

function requireWarningName(warningName: string): string {
    if (typeof warningName !== "string" || warningName.trim().length === 0) {
        throw new TypeError("warningName must be a non-empty string");
    }
    return warningName;
}

/** Return whether a warning has not succeeded within the central cooldown. */
export function isWarningDue(
    email: WarningEmail,
    warningName: string,
    now: Date = new Date(),
): boolean {
    const name = requireWarningName(warningName);
    const currentTime = now.getTime();
    if (!Number.isFinite(currentTime)) {
        return true;
    }

    const state = warningStateFromEmail(email, false);
    const lastSent = state[name];
    if (!lastSent) {
        return true;
    }

    const lastSentTime = Date.parse(lastSent);
    return Number.isNaN(lastSentTime) || currentTime - lastSentTime >= WARNING_COOLDOWN_MS;
}

/** Persist a warning marker only after the corresponding Slack call succeeds. */
export async function markWarningSent(
    email: WarningEmail,
    warningName: string,
    sentAt: Date | string = new Date(),
): Promise<void> {
    const name = requireWarningName(warningName);
    const timestamp = sentAt instanceof Date ? sentAt : new Date(sentAt);
    if (Number.isNaN(timestamp.getTime())) {
        throw new TypeError("sentAt must be a valid date");
    }

    const state = warningStateFromEmail(email, true);
    state[name] = timestamp.toISOString();
    await updateEmail(email["Airtable ID"], {
        Warnings: JSON.stringify(state),
    });
}
