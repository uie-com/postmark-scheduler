import { z } from "zod";

/**
 * Runtime configuration used by the server-side provider integrations.
 *
 * Configuration is deliberately loaded by `getConfig`, rather than at module
 * import time.  This keeps `next build` and routes that do not use a provider
 * independent from deployment secrets.  A successful parse is cached for the
 * lifetime of the process; call `clearConfigCacheForTests` when a test changes
 * `process.env`.
 */
export type RuntimeConfig = Readonly<{
    appUrl: string;
    slack: Readonly<{
        webhookUrl: string;
    }>;
    airtable: Readonly<{
        apiKey: string;
        baseId: string;
        tableId: string;
    }>;
    activeCampaign: Readonly<{
        apiKey: string;
        apiUrl: string;
    }>;
    postmark: Readonly<{
        apiKey: string;
    }>;
}>;

/** A safe, actionable error raised when a provider's runtime configuration is invalid. */
export class ConfigurationError extends Error {
    readonly issues: ReadonlyArray<{ path: string; message: string }>;

    constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
        const description = issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ");
        super(`Invalid runtime configuration: ${description}`);
        this.name = "ConfigurationError";
        this.issues = issues;
    }
}

let cachedConfig: RuntimeConfig | undefined;

const requiredString = (name: string) =>
    z
        .string()
        .trim()
        .min(1, `${name} is required`);

const httpUrl = (name: string) =>
    requiredString(name).refine(
        (value) => {
            try {
                const parsed = new URL(value);
                return (
                    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
                    parsed.hostname.length > 0 &&
                    parsed.username.length === 0 &&
                    parsed.password.length === 0
                );
            } catch {
                return false;
            }
        },
        `${name} must be a valid http or https URL without embedded credentials`,
    );

const environmentSchema = z.object({
    APP_URL: httpUrl("APP_URL"),
    SLACK_WEBHOOK_URL: httpUrl("SLACK_WEBHOOK_URL"),
    AIRTABLE_API_KEY: requiredString("AIRTABLE_API_KEY"),
    AIRTABLE_BASE_ID: requiredString("AIRTABLE_BASE_ID"),
    AIRTABLE_TABLE_ID: requiredString("AIRTABLE_TABLE_ID"),
    ACTIVECAMPAIGN_API_KEY: requiredString("ACTIVECAMPAIGN_API_KEY"),
    ACTIVECAMPAIGN_API_URL: httpUrl("ACTIVECAMPAIGN_API_URL"),
    POSTMARK_API_KEY: requiredString("POSTMARK_API_KEY"),
});

type Environment = z.infer<typeof environmentSchema>;

function formatSchemaIssues(error: z.ZodError): ReadonlyArray<{ path: string; message: string }> {
    return error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "environment";
        // Zod's invalid-type message contains no user value.  Replace it with
        // a concise required message so the error is useful at request-time.
        const message = issue.code === "invalid_type" ? "is required" : issue.message;
        return { path, message };
    });
}

/**
 * Return an ActiveCampaign API base with exactly one `/api/3` suffix.
 * Account roots, trailing slashes, and repeated version suffixes are accepted.
 */
export function normalizeActiveCampaignBaseUrl(value: string): string {
    const candidate = value.trim();
    let parsed: URL;

    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error("ActiveCampaign API URL must be a valid http or https URL");
    }

    if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:"
    ) {
        throw new Error("ActiveCampaign API URL must use http or https");
    }

    if (parsed.username || parsed.password) {
        throw new Error("ActiveCampaign API URL must not contain embedded credentials");
    }

    // A base URL cannot safely carry a query or fragment.  Dropping these
    // values also guarantees that the returned value has a true path suffix.
    let pathname = parsed.pathname.replace(/\/+$/, "");
    while (/\/api\/3$/i.test(pathname)) {
        pathname = pathname.slice(0, -5).replace(/\/+$/, "");
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    return `${origin}${pathname && pathname !== "/" ? pathname : ""}/api/3`;
}

function parseEnvironment(): RuntimeConfig {
    const parsed = environmentSchema.safeParse(process.env);

    if (!parsed.success) {
        throw new ConfigurationError(formatSchemaIssues(parsed.error));
    }

    const environment: Environment = parsed.data;
    const config: RuntimeConfig = {
        appUrl: environment.APP_URL,
        slack: {
            webhookUrl: environment.SLACK_WEBHOOK_URL,
        },
        airtable: {
            apiKey: environment.AIRTABLE_API_KEY,
            baseId: environment.AIRTABLE_BASE_ID,
            tableId: environment.AIRTABLE_TABLE_ID,
        },
        activeCampaign: {
            apiKey: environment.ACTIVECAMPAIGN_API_KEY,
            apiUrl: normalizeActiveCampaignBaseUrl(environment.ACTIVECAMPAIGN_API_URL),
        },
        postmark: {
            apiKey: environment.POSTMARK_API_KEY,
        },
    };

    // Configuration is shared by many request handlers.  Freeze each level so
    // one provider cannot accidentally change another provider's credentials.
    return Object.freeze({
        ...config,
        slack: Object.freeze(config.slack),
        airtable: Object.freeze(config.airtable),
        activeCampaign: Object.freeze(config.activeCampaign),
        postmark: Object.freeze(config.postmark),
    });
}

/** Lazily validate and return the process runtime configuration. */
export function getConfig(): RuntimeConfig {
    if (!cachedConfig) {
        cachedConfig = parseEnvironment();
    }

    return cachedConfig;
}

/** Clear the successful configuration cache (primarily useful in tests). */
export function clearConfigCacheForTests(): void {
    cachedConfig = undefined;
}
