import { z } from "zod";

/** Default request deadline.  Callers can override it for a known operation. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Maximum amount of an upstream error body retained in a safe error. */
export const MAX_ERROR_BODY_LENGTH = 4_096;

export type ProviderErrorOptions = {
    provider: string;
    operation: string;
    status?: number;
    retryable: boolean;
    details?: unknown;
    retryAfter?: string;
};

/**
 * Safe, structured failure from a provider request.
 *
 * `details` is sanitized and truncated before it is stored.  Request URLs,
 * request headers, and request bodies are intentionally never included.
 */
export class ProviderError extends Error {
    readonly provider: string;
    readonly operation: string;
    readonly status: number | undefined;
    readonly retryable: boolean;
    readonly details: string | undefined;
    /** Raw Retry-After header value, when the provider supplied one. */
    readonly retryAfter: string | undefined;
    /** Safe response body retained for callers that need to inspect it. */
    readonly responseBody: string | undefined;

    constructor(options: ProviderErrorOptions) {
        const provider = safeLabel(options.provider, "provider");
        const operation = safeLabel(options.operation, "operation");
        const details = safeDetails(options.details);
        const status = typeof options.status === "number" ? options.status : undefined;
        const retryAfter = options.retryAfter
            ? redactSensitiveText(options.retryAfter).slice(0, 128)
            : undefined;
        const statusDescription = status === undefined ? "" : ` (HTTP ${status})`;
        const detailDescription = details ? `: ${details}` : "";

        super(`${provider} ${operation} failed${statusDescription}${detailDescription}`);
        this.name = "ProviderError";
        this.provider = provider;
        this.operation = operation;
        this.status = status;
        this.retryable = options.retryable;
        this.details = details;
        this.retryAfter = retryAfter;
        this.responseBody = details;
    }
}

export type RequestJsonOptions<T> = {
    provider: string;
    operation: string;
    url: string | URL;
    init?: RequestInit;
    schema: z.ZodType<T>;
    timeoutMs?: number;
};

function safeLabel(value: string, fallback: string): string {
    const label = redactSensitiveText(String(value)).trim();
    return label || fallback;
}

function isSensitiveKey(key: string): boolean {
    return /(authorization|api[-_]?key|token|secret|password|credential|cookie)/i.test(key);
}

/** Remove common credential forms without retaining the original value. */
export function redactSensitiveText(value: string): string {
    return value
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
        .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
        .replace(
            /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
            (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
        );
}

function redactValue(value: unknown, seen: Set<unknown> = new Set()): unknown {
    if (typeof value === "string") {
        return redactSensitiveText(value);
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, seen));
    }

    const object: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        object[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(item, seen);
    }
    return object;
}

function truncate(value: string, maxLength = MAX_ERROR_BODY_LENGTH): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 20))}… [truncated]`;
}

function safeDetails(details: unknown): string | undefined {
    if (details === undefined || details === null) {
        return undefined;
    }

    if (typeof details === "string") {
        const safe = truncate(redactSensitiveText(details));
        return safe || undefined;
    }

    try {
        const serialized = JSON.stringify(redactValue(details));
        return serialized ? truncate(serialized) : undefined;
    } catch {
        return "[unavailable]";
    }
}

function safeResponseBody(body: string): string | undefined {
    if (!body.trim()) {
        return undefined;
    }

    // Parse JSON before redacting so credential-like keys are removed even
    // when their values contain spaces or punctuation.
    try {
        const parsed: unknown = JSON.parse(body);
        return safeDetails(parsed);
    } catch {
        const safe = truncate(redactSensitiveText(body));
        return safe || undefined;
    }
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function safeThrownMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return truncate(redactSensitiveText(error.message), 512);
    }
    return "Network request failed";
}

function schemaIssues(schemaError: z.ZodError): unknown {
    return {
        message: "Provider response did not match the expected schema",
        issues: schemaError.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
        })),
    };
}

/**
 * Fetch JSON with a deadline, safe upstream error details, and optional Zod
 * response validation.  The response body is consumed once and never logged.
 */
export async function requestJson<T = unknown>(options: RequestJsonOptions<T>): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("timeoutMs must be a finite number greater than zero");
    }

    const controller = new AbortController();
    const callerSignal = options.init?.signal;
    let timedOut = false;
    let callerAborted = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const abortFromCaller = () => {
        callerAborted = true;
        controller.abort();
    };

    if (callerSignal) {
        if (callerSignal.aborted) {
            abortFromCaller();
        } else {
            callerSignal.addEventListener("abort", abortFromCaller, { once: true });
        }
    }

    timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    const cleanup = () => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
        }
        callerSignal?.removeEventListener("abort", abortFromCaller);
    };

    let response: Response;
    try {
        response = await fetch(options.url, {
            ...options.init,
            signal: controller.signal,
        });
    } catch (error) {
        const details = timedOut
            ? `Request timed out after ${timeoutMs} ms`
            : callerAborted
                ? "Request was aborted"
                : safeThrownMessage(error);
        cleanup();
        throw new ProviderError({
            provider: options.provider,
            operation: options.operation,
            retryable: timedOut || !callerAborted,
            details,
        });
    }

    try {
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        let bodyText: string;
        try {
            bodyText = await response.text();
        } catch (error) {
            throw new ProviderError({
                provider: options.provider,
                operation: options.operation,
                status: response.status,
                retryable: timedOut || isRetryableStatus(response.status),
                retryAfter,
                details: timedOut
                    ? `Request timed out after ${timeoutMs} ms`
                    : `Unable to read provider response: ${safeThrownMessage(error)}`,
            });
        }

        if (timedOut) {
            throw new ProviderError({
                provider: options.provider,
                operation: options.operation,
                status: response.status,
                retryable: true,
                retryAfter,
                details: `Request timed out after ${timeoutMs} ms`,
            });
        }

        const safeBody = safeResponseBody(bodyText);

        if (!response.ok) {
            throw new ProviderError({
                provider: options.provider,
                operation: options.operation,
                status: response.status,
                retryable: isRetryableStatus(response.status),
                retryAfter,
                details: safeBody ?? (response.statusText ? redactSensitiveText(response.statusText) : undefined),
            });
        }

        let payload: unknown;
        if (!bodyText.trim()) {
            payload = undefined;
        } else {
            try {
                payload = JSON.parse(bodyText) as unknown;
            } catch {
                throw new ProviderError({
                    provider: options.provider,
                    operation: options.operation,
                    status: response.status,
                    retryable: false,
                    retryAfter,
                    details: {
                        message: "Provider response was not valid JSON",
                        responseBody: safeBody,
                    },
                });
            }
        }

        const parsed = options.schema.safeParse(payload);
        if (!parsed.success) {
            throw new ProviderError({
                provider: options.provider,
                operation: options.operation,
                status: response.status,
                retryable: false,
                retryAfter,
                details: schemaIssues(parsed.error),
            });
        }

        return parsed.data;
    } finally {
        // Keep the timer alive through body consumption and schema validation;
        // a response can expose headers before its body becomes available.
        cleanup();
    }
}

/** Return a safe human-readable description for logging or user-facing alerts. */
export function getErrorDescription(error: unknown): string {
    if (error instanceof ProviderError) {
        return error.message;
    }
    if (error instanceof Error) {
        return error.message ? redactSensitiveText(error.message) : error.name;
    }
    const description = redactSensitiveText(String(error));
    return description || "Unknown error";
}
