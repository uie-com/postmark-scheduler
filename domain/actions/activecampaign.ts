import { getConfig } from "../config";
import { ProviderError, requestJson } from "../http";
import { FETCH_DELAY_SEC } from "../settings";
import {
    Automation,
    AutomationResponseSchema,
    AutomationRun,
    AutomationRunSchema,
    CollectionMetaSchema,
    Contact,
    ContactResponseSchema,
    ContactVariables,
    Field,
    FieldSchema,
    FieldValue,
    FieldValuesResponseSchema,
    ShortenedContact,
    ShortenedContactSchema,
    Template,
    TemplateResponseSchema,
} from "../types";
import { z } from "zod";

const PROVIDER = "ActiveCampaign";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type QueryValue = string | number | undefined;
type QueryParams = Record<string, QueryValue>;

type PaginatedResult<T> = {
    items: T[];
    total: number;
};

function activeCampaignUrl(path: string, params?: QueryParams): string {
    const { activeCampaign } = getConfig();
    const url = new URL(`${activeCampaign.apiUrl}/${path.replace(/^\/+/, "")}`);

    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
    }

    return url.toString();
}

function requestHeaders(): HeadersInit {
    return {
        "Content-Type": "application/json",
        "Api-Token": getConfig().activeCampaign.apiKey,
    };
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function paginationError(operation: string, details: string): ProviderError {
    return new ProviderError({
        provider: PROVIDER,
        operation,
        retryable: false,
        details,
    });
}

function paginatedPageSchema<T>(key: string, itemSchema: z.ZodType<T>) {
    return z
        .object({
            meta: CollectionMetaSchema,
        })
        .catchall(z.unknown())
        .transform((page, context): PaginatedResult<T> => {
            const rawItems = page[key];
            if (!Array.isArray(rawItems)) {
                context.addIssue({
                    code: "custom",
                    path: [key],
                    message: `Expected '${key}' to be an array`,
                });
                return undefined as never;
            }

            const parsedItems = z.array(itemSchema).safeParse(rawItems);
            if (!parsedItems.success) {
                for (const issue of parsedItems.error.issues) {
                    context.addIssue({
                        code: "custom",
                        path: [key, ...issue.path],
                        message: issue.message,
                    });
                }
                return undefined as never;
            }

            return {
                items: parsedItems.data,
                total: page.meta.total,
            };
        });
}

async function fetchPaginatedCollection<T>(
    url: string,
    key: string,
    itemSchema: z.ZodType<T>,
    params: QueryParams = {},
    limit: number = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new RangeError(`ActiveCampaign page size must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }

    const pageSchema = paginatedPageSchema(key, itemSchema);
    const results: T[] = [];
    let offset = 0;
    let expectedTotal = 0;
    let firstPage = true;

    while (firstPage || offset < expectedTotal) {
        const page = await requestJson<PaginatedResult<T>>({
            provider: PROVIDER,
            operation: `list ${key}`,
            url: activeCampaignUrlFromBase(url, {
                ...params,
                offset,
                limit,
            }),
            init: { headers: requestHeaders() },
            schema: pageSchema,
        });

        if (page.items.length > limit) {
            throw paginationError(
                `list ${key}`,
                `Provider returned ${page.items.length} records for a page of ${limit}`,
            );
        }

        expectedTotal = Math.max(expectedTotal, page.total);
        if (page.total < offset + page.items.length) {
            throw paginationError(
                `list ${key}`,
                `Provider total ${page.total} is smaller than the records returned at offset ${offset}`,
            );
        }

        if (page.items.length === 0 && offset < expectedTotal) {
            throw paginationError(
                `list ${key}`,
                `Provider returned an empty page before the reported total of ${expectedTotal}`,
            );
        }

        results.push(...page.items);
        if (page.items.length === 0) {
            // A zero-total empty first page is a valid empty collection.  Any
            // other empty page was rejected above because it cannot make
            // progress toward the reported total.
            firstPage = false;
            break;
        }

        const previousOffset = offset;
        offset += page.items.length;
        if (offset <= previousOffset) {
            throw paginationError(`list ${key}`, "Pagination offset did not advance");
        }

        firstPage = false;
    }

    if (results.length < expectedTotal) {
        throw paginationError(
            `list ${key}`,
            `Pagination ended with ${results.length} records, below the reported total of ${expectedTotal}`,
        );
    }

    return results;
}

function activeCampaignUrlFromBase(baseUrl: string, params: QueryParams): string {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

// TEMPLATES

export async function parseTemplateContent(template: Template): Promise<string> {
    const previewContent = template.preview_content?.trim();
    const templateContent = template.content?.trim();
    const content = previewContent || templateContent;

    if (!content) {
        const templateId = template.id ? ` '${template.id}'` : "";
        throw new Error(`ActiveCampaign template${templateId} has no usable content`);
    }

    // Remove AC footer.
    return content.replace(/<table class="es-footer ac-footer[\s\S]*?<\/table>/gi, "");
}

export async function getTemplateDetails(templateId: string): Promise<Template> {
    console.log(`[AC] Fetching template contents for ID: ${templateId}`);

    const response = await requestJson<z.infer<typeof TemplateResponseSchema>>({
        provider: PROVIDER,
        operation: "retrieve template",
        url: activeCampaignUrl(`templates/${encodeURIComponent(templateId)}`),
        init: { headers: requestHeaders() },
        schema: TemplateResponseSchema,
    });

    return response.template;
}

export function fillContentVariables(content: string, variables: ContactVariables): string {
    let filledTemplate = content;

    for (const [key, value] of Object.entries(variables)) {
        const placeholder = new RegExp(`%${escapeRegularExpression(key)}%`, "gi");
        filledTemplate = filledTemplate.replace(placeholder, () => value);
    }

    filledTemplate = filledTemplate.replace(/%([A-Z0-9_-]+)%/gi, (match) => {
        console.warn("[WARN] Found variable with no value: " + match);
        return "";
    });

    return filledTemplate;
}

// AUTOMATIONS

export async function getActiveContactsInAutomation(automationId: string): Promise<ShortenedContact[]> {
    const allContacts = await getAllContactsForAutomation(automationId);
    const runs = await getAutomationRuns(automationId);

    const activeContactsById = new Set(
        runs
            .filter((run) => run.completed === 0)
            .map((run) => run.contact),
    );
    const runContactIds = new Set(runs.map((run) => run.contact));

    const activeContacts = allContacts.filter((contact) => activeContactsById.has(contact.id));
    const missingContacts = allContacts.filter((contact) => !runContactIds.has(contact.id));
    if (missingContacts.length > 0) {
        console.warn(`[AC] Found ${missingContacts.length} contacts that are missing from automation runs.`);
    }

    console.log(`[AC] Cross-referenced ${activeContacts.length} active contacts in automation ID: ${automationId}`);
    return activeContacts;
}

export async function getAutomationDetails(automationId: string): Promise<Automation> {
    console.log(`[AC] Fetching automation details for ID: ${automationId}`);

    const response = await requestJson<z.infer<typeof AutomationResponseSchema>>({
        provider: PROVIDER,
        operation: "retrieve automation",
        url: activeCampaignUrl(`automations/${encodeURIComponent(automationId)}`),
        init: { headers: requestHeaders() },
        schema: AutomationResponseSchema,
    });

    return response.automation;
}

export async function getAutomationRuns(automationId: string): Promise<AutomationRun[]> {
    console.log(`[AC] Fetching runs inside automation ID: ${automationId}`);

    const automationRuns = await fetchPaginatedCollection(
        activeCampaignUrl(`automations/${encodeURIComponent(automationId)}/contactAutomations`),
        "contactAutomations",
        AutomationRunSchema,
        {},
        MAX_PAGE_SIZE,
    );

    console.log(`[AC] Fetched ${automationRuns.length} automation runs.`);
    return automationRuns;
}

export async function getAllContactsForAutomation(automationId: string): Promise<ShortenedContact[]> {
    console.log(`[AC] Fetching contacts inside automation ID: ${automationId}`);

    const contacts = await paginatedFetch<ShortenedContact>(
        activeCampaignUrl("contacts"),
        "contacts",
        { seriesid: automationId },
        MAX_PAGE_SIZE,
        ShortenedContactSchema,
    );

    console.log(`[AC] Found ${contacts.length} contacts.`);
    return contacts;
}

// CONTACTS

export async function listFields(): Promise<Field[]> {
    return paginatedFetch<Field>(
        activeCampaignUrl("fields"),
        "fields",
        {},
        MAX_PAGE_SIZE,
        FieldSchema,
    );
}

export async function getContactDetails(contactId: string): Promise<Contact> {
    console.log(`[AC] Fetching contact details for ID: ${contactId}`);

    return requestJson<Contact>({
        provider: PROVIDER,
        operation: "retrieve contact",
        url: activeCampaignUrl(`contacts/${encodeURIComponent(contactId)}`),
        init: { headers: requestHeaders() },
        schema: ContactResponseSchema,
    });
}

export async function getContactFieldValues(contactId: string): Promise<FieldValue[]> {
    console.log(`[AC] Fetching contact fields for ID: ${contactId}`);

    const response = await requestJson<z.infer<typeof FieldValuesResponseSchema>>({
        provider: PROVIDER,
        operation: "retrieve contact field values",
        url: activeCampaignUrl(`contacts/${encodeURIComponent(contactId)}/fieldValues`),
        init: { headers: requestHeaders() },
        schema: FieldValuesResponseSchema,
    });

    return response.fieldValues;
}

export async function getContactVariables(
    contact: ShortenedContact,
    fields: Field[],
    includeCustom = false,
): Promise<ContactVariables> {
    console.log(`[AC] Fetching contact variables for ID: ${contact.id}`);

    const variables: ContactVariables = {
        ID: contact.id,
        EMAIL: contact.email,
    };

    if (includeCustom) {
        const fieldValues = await getContactFieldValues(contact.id);
        for (const fieldValue of fieldValues) {
            const field = fields.find((candidate) => candidate.id === fieldValue.field);
            if (!field) {
                console.warn(`[WARN] Unknown ActiveCampaign field '${fieldValue.field}' for contact '${contact.id}'`);
                continue;
            }
            if (typeof fieldValue.value === "string") {
                variables[field.perstag.toUpperCase()] = fieldValue.value;
            }
        }
    }

    for (const [contactKey, value] of Object.entries(contact)) {
        if (typeof value === "string") {
            variables[contactKey.toUpperCase()] = value;
        }
    }

    return variables;
}

export async function getAllContactVariables(
    contacts: ShortenedContact[],
    fields: Field[],
    includeCustom = false,
): Promise<ContactVariables[]> {
    const contactVariables: ContactVariables[] = [];

    for (const [index, contact] of contacts.entries()) {
        contactVariables.push(await getContactVariables(contact, fields, includeCustom));

        if (includeCustom && index < contacts.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_SEC * 1000));
        }
    }

    return contactVariables;
}

// UTILS

export async function paginatedFetch<T>(
    url: string,
    key: string,
    params: QueryParams = {},
    limit = DEFAULT_PAGE_SIZE,
    itemSchema: z.ZodType<T>,
): Promise<T[]> {
    return fetchPaginatedCollection(url, key, itemSchema, params, limit);
}
