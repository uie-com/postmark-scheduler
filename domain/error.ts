import { getErrorDescription, ProviderError } from "./http";
import { sendSlackMessage } from "./actions/slack";

/** A provider-safe failure shape used by workers and progress reporting. */
export type StructuredError = {
    description: string;
    provider?: string;
    operation?: string;
    status?: number;
    retryable?: boolean;
};

function safeDescription(value: string): string {
    return value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 512);
}

/**
 * Convert an unknown failure into a bounded, credential-safe description.
 * ProviderError already redacts response details; generic errors are passed
 * through the same sanitizer in getErrorDescription.
 */
export function describeError(error: unknown): StructuredError {
    if (error instanceof ProviderError) {
        return {
            description: safeDescription(getErrorDescription(error)),
            provider: error.provider,
            operation: error.operation,
            ...(error.status === undefined ? {} : { status: error.status }),
            retryable: error.retryable,
        };
    }

    return { description: safeDescription(getErrorDescription(error)) };
}

/**
 * Log a structured operation failure without leaking request bodies, secrets,
 * recipient addresses, or provider credentials.
 */
export function logError(operation: string, error: unknown): StructuredError {
    const failure = describeError(error);
    const details = {
        operation,
        provider: failure.provider,
        status: failure.status,
        retryable: failure.retryable,
        description: failure.description,
    };
    console.error("[ERROR]", details);
    return failure;
}

/**
 * Best-effort operational notification. Notification failures are logged and
 * deliberately never replace or rethrow the original worker failure.
 */
export async function notifyError(
    operation: string,
    error: unknown,
): Promise<StructuredError> {
    const failure = logError(operation, error);
    try {
        await sendSlackMessage(
            `⛔ ${operation} failed: ${failure.description}`,
        );
    } catch (notificationError) {
        const notification = describeError(notificationError);
        console.error("[ERROR] Failed to notify Slack", {
            operation: "send Slack error notification",
            provider: notification.provider,
            status: notification.status,
            retryable: notification.retryable,
            description: notification.description,
        });
    }
    return failure;
}
