import { z } from "zod";
import { getConfig } from "../config";
import { DEFAULT_TIMEOUT_MS, ProviderError, getErrorDescription, requestJson } from "../http";
import { FROM_EMAIL, MESSAGE_STREAM } from "../settings";
import { ContactVariables, Email, EmailSendResponse, PostmarkEmail, ShortenedContact } from "../types";
import { fillContentVariables } from "./activecampaign";

export const POSTMARK_BATCH_MAX_MESSAGES = 500;
export const POSTMARK_BATCH_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const POSTMARK_BATCH_URL = "https://api.postmarkapp.com/email/batch";

export type PostmarkBatchOutcome =
    | "complete"
    | "rejected/partial-known"
    | "unknown/ambiguous";

export type PostmarkBatchChunkReport = {
    index: number;
    messageCount: number;
    outcome: PostmarkBatchOutcome;
    responses: EmailSendResponse[];
    error?: {
        description: string;
        status?: number;
        retryable: boolean;
    };
};

export type PostmarkBatchReport = {
    outcome: PostmarkBatchOutcome;
    responses: EmailSendResponse[];
    chunks: PostmarkBatchChunkReport[];
    totalMessages: number;
    submittedMessages: number;
    respondedMessages: number;
    unsubmittedMessages: number;
    ambiguousMessages: number;
    error?: string;
};

const postmarkResponseSchema = z.object({
    ErrorCode: z.number(),
    Message: z.string(),
    MessageID: z.string().optional(),
    SubmittedAt: z.string().optional(),
    To: z.string().optional(),
}).superRefine((response, context) => {
    if (response.ErrorCode !== 0) {
        return;
    }

    for (const field of ["MessageID", "SubmittedAt", "To"] as const) {
        if (!response[field]) {
            context.addIssue({
                code: "custom",
                path: [field],
                message: `${field} is required for an accepted Postmark message`,
            });
        }
    }
});

const postmarkResponseArraySchema = z.array(postmarkResponseSchema);

type PlannedChunk = {
    payload: string;
    messageCount: number;
};

type SerializedMessage = {
    payload: string;
    bytes: number;
};

type PlanFailure = {
    index: number;
    description: string;
};

type ChunkSubmission = {
    outcome: PostmarkBatchOutcome;
    responses: EmailSendResponse[];
    error?: ProviderError;
};

export async function createBatchEmailArray(recipients: ShortenedContact[], email: Email, htmlContent: string, variables: ContactVariables[]): Promise<PostmarkEmail[]> {
    return recipients.map(recipient => {
        let variableSet = variables.find(v => v.ID === recipient.id);
        if (!variableSet) {
            console.warn('[WARN] No variables found for ActiveCampaign contact ID: ' + recipient.id);
            variableSet = { ID: recipient.id, EMAIL: recipient.email, FIRSTNAME: recipient.firstName };
        }

        return {
            From: FROM_EMAIL,
            To: recipient.email,
            Subject: email.Subject,
            HtmlBody: fillContentVariables(htmlContent, variableSet),
            TextBody: '',
            MessageStream: MESSAGE_STREAM,
            Tag: email["Email Tag"],
            "TrackOpens": true,
            "TrackLinks": "HtmlAndText",
        }
    });
}

const textEncoder = new TextEncoder();

function serializeMessage(message: PostmarkEmail): SerializedMessage | { error: string } {
    try {
        const payload = JSON.stringify(message);
        if (payload === undefined) {
            return { error: "Postmark batch payload could not be serialized" };
        }

        return {
            payload,
            bytes: textEncoder.encode(payload).byteLength,
        };
    } catch (error) {
        return { error: `Postmark batch payload could not be serialized: ${getErrorDescription(error)}` };
    }
}

function planChunks(emails: PostmarkEmail[]): { chunks: PlannedChunk[]; failure?: PlanFailure } {
    const chunks: PlannedChunk[] = [];
    let currentMessages: string[] = [];
    let currentBytes = 2;

    const flush = () => {
        if (currentMessages.length === 0) {
            return;
        }

        chunks.push({
            payload: `[${currentMessages.join(",")}]`,
            messageCount: currentMessages.length,
        });
        currentMessages = [];
        currentBytes = 2;
    };

    for (let index = 0; index < emails.length; index += 1) {
        const email = emails[index];
        const single = serializeMessage(email);
        if ("error" in single) {
            flush();
            return {
                chunks,
                failure: { index, description: single.error },
            };
        }

        const singleArrayBytes = single.bytes + 2;
        if (singleArrayBytes > POSTMARK_BATCH_MAX_PAYLOAD_BYTES) {
            flush();
            return {
                chunks,
                failure: {
                    index,
                    description: `Postmark message ${index + 1} exceeds the ${POSTMARK_BATCH_MAX_PAYLOAD_BYTES}-byte batch limit and was not submitted`,
                },
            };
        }

        const candidateBytes = currentMessages.length === 0
            ? singleArrayBytes
            : currentBytes + 1 + single.bytes;
        const exceedsMessageLimit = currentMessages.length >= POSTMARK_BATCH_MAX_MESSAGES;
        const exceedsPayloadLimit = candidateBytes > POSTMARK_BATCH_MAX_PAYLOAD_BYTES;
        if (exceedsMessageLimit || exceedsPayloadLimit) {
            flush();
            currentMessages = [single.payload];
            currentBytes = singleArrayBytes;
            continue;
        }

        currentMessages.push(single.payload);
        currentBytes = candidateBytes;
    }

    flush();
    return { chunks };
}

function providerErrorForUnknownFailure(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
        return error;
    }

    return new ProviderError({
        provider: "Postmark",
        operation: "send batch email",
        retryable: true,
        details: getErrorDescription(error),
    });
}

function chunkError(error: ProviderError): { description: string; status?: number; retryable: boolean } {
    return {
        description: getErrorDescription(error),
        status: error.status,
        retryable: error.retryable,
    };
}

function isDefinitiveProviderRejection(error: ProviderError): boolean {
    return error.status !== undefined && (error.status < 200 || error.status >= 300);
}

async function submitChunk(apiKey: string, chunk: PlannedChunk): Promise<ChunkSubmission> {
    try {
        const responses = await requestJson<EmailSendResponse[]>({
            provider: "Postmark",
            operation: "send batch email",
            url: POSTMARK_BATCH_URL,
            init: {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-Postmark-Server-Token": apiKey,
                },
                body: chunk.payload,
            },
            timeoutMs: DEFAULT_TIMEOUT_MS,
            schema: postmarkResponseArraySchema,
        });

        if (responses.length !== chunk.messageCount) {
            return {
                outcome: "unknown/ambiguous",
                responses: [],
                error: new ProviderError({
                    provider: "Postmark",
                    operation: "validate batch email response",
                    status: 200,
                    retryable: false,
                    details: `Expected ${chunk.messageCount} responses but received ${responses.length}`,
                }),
            };
        }

        const outcome = responses.every(response => response.ErrorCode === 0)
            ? "complete"
            : "rejected/partial-known";

        return { outcome, responses };
    } catch (error) {
        const providerError = providerErrorForUnknownFailure(error);
        return {
            outcome: isDefinitiveProviderRejection(providerError)
                ? "rejected/partial-known"
                : "unknown/ambiguous",
            responses: [],
            error: providerError,
        };
    }
}

function reportForConfigurationFailure(totalMessages: number, error: unknown): PostmarkBatchReport {
    const providerError = providerErrorForUnknownFailure(error);
    const chunk: PostmarkBatchChunkReport = {
        index: 0,
        messageCount: totalMessages,
        outcome: "rejected/partial-known",
        responses: [],
        error: {
            ...chunkError(providerError),
            retryable: false,
        },
    };

    return {
        outcome: "rejected/partial-known",
        responses: [],
        chunks: totalMessages === 0 ? [] : [chunk],
        totalMessages,
        submittedMessages: 0,
        respondedMessages: 0,
        unsubmittedMessages: totalMessages,
        ambiguousMessages: 0,
        error: getErrorDescription(providerError),
    };
}

/**
 * Submit a Postmark batch at most once per planned chunk.
 *
 * The report distinguishes provider rejection from an unknown result after a
 * request was initiated. Callers must not resubmit an unknown chunk because
 * Postmark may have accepted it before the response was lost.
 */
export async function sendBatchEmailOnce(emails: PostmarkEmail[]): Promise<PostmarkBatchReport> {
    if (emails.length === 0) {
        return {
            outcome: "complete",
            responses: [],
            chunks: [],
            totalMessages: 0,
            submittedMessages: 0,
            respondedMessages: 0,
            unsubmittedMessages: 0,
            ambiguousMessages: 0,
        };
    }

    let apiKey: string;
    try {
        apiKey = getConfig().postmark.apiKey;
    } catch (error) {
        return reportForConfigurationFailure(emails.length, error);
    }

    let plan: { chunks: PlannedChunk[]; failure?: PlanFailure };
    try {
        plan = planChunks(emails);
    } catch (error) {
        return reportForConfigurationFailure(emails.length, error);
    }

    const chunks: PostmarkBatchChunkReport[] = [];
    const responses: EmailSendResponse[] = [];
    let submittedMessages = 0;
    let respondedMessages = 0;
    let unsubmittedMessages = emails.length;
    let ambiguousMessages = 0;
    let outcome: PostmarkBatchOutcome = "complete";
    let firstError: string | undefined;

    for (let index = 0; index < plan.chunks.length; index += 1) {
        const chunk = plan.chunks[index];
        submittedMessages += chunk.messageCount;
        unsubmittedMessages -= chunk.messageCount;

        const submission = await submitChunk(apiKey, chunk);
        const report: PostmarkBatchChunkReport = {
            index,
            messageCount: chunk.messageCount,
            outcome: submission.outcome,
            responses: submission.responses,
            ...(submission.error ? { error: chunkError(submission.error) } : {}),
        };
        chunks.push(report);

        responses.push(...submission.responses);
        respondedMessages += submission.responses.length;

        if (submission.outcome === "complete") {
            continue;
        }

        outcome = submission.outcome;
        firstError = submission.error ? getErrorDescription(submission.error) : undefined;
        if (submission.outcome === "unknown/ambiguous") {
            ambiguousMessages += chunk.messageCount;
        }
        break;
    }

    const completedAllPlannedChunks = chunks.length === plan.chunks.length && outcome === "complete";
    if (plan.failure && completedAllPlannedChunks) {
        const failureReport: PostmarkBatchChunkReport = {
            index: chunks.length,
            messageCount: 1,
            outcome: "rejected/partial-known",
            responses: [],
            error: {
                description: plan.failure.description,
                retryable: false,
            },
        };
        chunks.push(failureReport);
        outcome = "rejected/partial-known";
        firstError = plan.failure.description;
    }

    return {
        outcome,
        responses,
        chunks,
        totalMessages: emails.length,
        submittedMessages,
        respondedMessages,
        unsubmittedMessages,
        ambiguousMessages,
        ...(firstError ? { error: firstError } : {}),
    };
}
