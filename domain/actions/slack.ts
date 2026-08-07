import { getConfig } from "../config";
import { DEFAULT_TIMEOUT_MS, ProviderError, getErrorDescription } from "../http";
import { SlackPayload } from "../types";

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Send one message to the configured Slack Workflow webhook.
 *
 * Workflow triggers accept the top-level `message` input. This intentionally
 * uses a raw bounded request because the trigger's successful response body is
 * not a stable Web API JSON contract; every response body is still consumed.
 */
export async function sendSlackMessage(message: string): Promise<void> {
    let webhookUrl: string;
    try {
        webhookUrl = getConfig().slack.webhookUrl;
    } catch (error) {
        throw new ProviderError({
            provider: "Slack",
            operation: "send workflow message",
            retryable: false,
            details: getErrorDescription(error),
        });
    }

    const payload: SlackPayload = { message };
    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, DEFAULT_TIMEOUT_MS);

    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        let responseBody: string;
        try {
            responseBody = await response.text();
        } catch (error) {
            throw new ProviderError({
                provider: "Slack",
                operation: "send workflow message",
                status: response.status,
                retryable: true,
                retryAfter: response.headers.get("retry-after") ?? undefined,
                details: timedOut
                    ? `Request timed out after ${DEFAULT_TIMEOUT_MS} ms`
                    : `Unable to read Slack response: ${getErrorDescription(error)}`,
            });
        }

        if (timedOut) {
            throw new ProviderError({
                provider: "Slack",
                operation: "send workflow message",
                status: response.status,
                retryable: true,
                retryAfter: response.headers.get("retry-after") ?? undefined,
                details: `Request timed out after ${DEFAULT_TIMEOUT_MS} ms`,
            });
        }

        if (!response.ok) {
            throw new ProviderError({
                provider: "Slack",
                operation: "send workflow message",
                status: response.status,
                retryable: isRetryableStatus(response.status),
                retryAfter: response.headers.get("retry-after") ?? undefined,
                details: responseBody || response.statusText || undefined,
            });
        }
    } catch (error) {
        if (error instanceof ProviderError) {
            throw error;
        }

        throw new ProviderError({
            provider: "Slack",
            operation: "send workflow message",
            retryable: timedOut || !controller.signal.aborted,
            details: timedOut
                ? `Request timed out after ${DEFAULT_TIMEOUT_MS} ms`
                : getErrorDescription(error),
        });
    } finally {
        clearTimeout(timeoutHandle);
    }
}
