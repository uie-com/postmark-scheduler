
import { z } from "zod";

// SLACK
export type SlackPayload = {
    message: string;
}


// AIRTABLE
export type Email = {
    "Airtable ID": string;
    "Email ID": string;
    "Template ID": string;
    "Schedule Date": string;
    "Automation ID": string;
    "Status": string;
    "Subject": string;
    "Last Modified": string;
    "Sent At": string;
    "Email Tag": string;
    "Test Number": number;
}

export type AirtableEmailItem = {
    "Email ID": string;
    "Template ID": string;
    "Schedule Date": string;
    "Automation ID": string;
    "Status": string;
    "Subject": string;
    "Last Modified": string;
    "Sent At": string;
    "Email Tag": string;
    "Warnings": string;
    "Test Number": number;
}

export type AirtableRecord<T> = {
    id: string;
    fields: T;
    createdTime: string;
}

export type AirtableResponse<T> = {
    records: AirtableRecord<T>[];
    offset?: string;
}


// ACTIVECAMPAIGN

const accountValue = z.union([z.string(), z.number()]).transform((value) => String(value));
const nullableAccountValue = accountValue.nullable().optional();
const accountInteger = z.union([
    z.number().int(),
    z.string().regex(/^-?\d+$/).transform((value) => Number(value)),
]);
const nullableAccountInteger = accountInteger.nullable().optional();
const optionalString = z.string().nullable().optional();
const linksSchema = z.record(z.string(), z.string());

export const CollectionMetaSchema = z.object({
    total: accountInteger,
}).passthrough();

export type CollectionMeta = z.infer<typeof CollectionMetaSchema>;

export const AutomationLinksSchema = linksSchema;
export type AutomationLinks = z.infer<typeof AutomationLinksSchema>;

export const AutomationSchema = z.object({
    name: z.string(),
    cdate: optionalString,
    mdate: optionalString,
    userid: nullableAccountValue,
    status: nullableAccountValue,
    entered: nullableAccountValue,
    exited: nullableAccountValue,
    hidden: nullableAccountValue,
    entitlements_violation: nullableAccountValue,
    source: nullableAccountValue,
    description: z.string().nullable().optional(),
    exit_on_unsubscribe: nullableAccountValue,
    exit_on_conversion: nullableAccountValue,
    multientry: nullableAccountValue,
    links: AutomationLinksSchema.optional(),
    id: accountValue,
}).passthrough();

export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationResponseSchema = z.object({
    automation: AutomationSchema,
}).passthrough();

export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;

export const TemplateSchema = z.object({
    userid: nullableAccountValue,
    ed_instanceid: nullableAccountValue,
    ed_version: nullableAccountValue,
    name: z.string(),
    subject: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    categoryid: nullableAccountValue,
    used: nullableAccountValue,
    waitpreview: nullableAccountValue,
    importnum: nullableAccountValue,
    mdate: optionalString,
    preview_content: z.string().nullable().optional(),
    id: nullableAccountValue,
    modified: nullableAccountValue,
    hidden: nullableAccountValue,
    links: z.union([linksSchema, z.array(z.unknown())]).optional(),
}).passthrough();

export type Template = z.infer<typeof TemplateSchema>;

export const TemplateResponseSchema = z.object({
    template: TemplateSchema,
}).passthrough();

export type TemplateResponse = z.infer<typeof TemplateResponseSchema>;

export const AutomationRunSchema = z.object({
    contact: accountValue,
    seriesid: accountValue,
    startid: nullableAccountValue,
    status: nullableAccountValue,
    batchid: z.union([accountValue, z.null()]).optional(),
    adddate: optionalString,
    remdate: optionalString,
    timespan: nullableAccountValue,
    lastblock: nullableAccountValue,
    lastlogid: nullableAccountValue,
    lastdate: optionalString,
    in_als: nullableAccountValue,
    completedElements: nullableAccountInteger,
    totalElements: nullableAccountInteger,
    completed: accountInteger,
    completeValue: nullableAccountInteger,
    links: linksSchema.optional(),
    id: accountValue,
    automation: accountValue,
}).passthrough();

export type AutomationRun = z.infer<typeof AutomationRunSchema>;

export const AutomationRunResponseSchema = z.object({
    contactAutomations: z.array(AutomationRunSchema),
    meta: CollectionMetaSchema,
}).passthrough();

export type AutomationRunResponse = z.infer<typeof AutomationRunResponseSchema>;

export const ShortenedContactSchema = z.object({
    id: accountValue,
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string().optional(),
    cdate: optionalString,
    orgid: nullableAccountValue,
    orgname: optionalString,
    segmentio_id: optionalString,
    bounced_hard: nullableAccountValue,
    bounced_soft: nullableAccountValue,
    bounced_date: optionalString,
    ip: optionalString,
    ua: optionalString,
    hash: optionalString,
    socialdata_lastcheck: optionalString,
    email_local: optionalString,
    email_domain: optionalString,
    sentcnt: nullableAccountValue,
    rating_tstamp: optionalString,
    gravatar: nullableAccountValue,
    deleted: nullableAccountValue,
    anonymized: nullableAccountValue,
    adate: optionalString,
    udate: optionalString,
    edate: optionalString,
    deleted_at: optionalString,
    created_utc_timestamp: optionalString,
    updated_utc_timestamp: optionalString,
    created_timestamp: optionalString,
    updated_timestamp: optionalString,
    created_by: nullableAccountValue,
    updated_by: nullableAccountValue,
    mpp_tracking: nullableAccountValue,
    last_click_date: optionalString,
    last_open_date: optionalString,
    last_mpp_open_date: optionalString,
    best_send_hour: optionalString,
    accountContacts: z.array(z.unknown()).optional(),
    scoreValues: z.array(z.unknown()).optional(),
    links: linksSchema.optional(),
    organization: z.unknown().nullable().optional(),
}).passthrough();

export type ShortenedContact = z.infer<typeof ShortenedContactSchema>;

export const ContactListSchema = z.record(z.string(), z.unknown());
export type ContactList = z.infer<typeof ContactListSchema>;

export const FieldValueSchema = z.object({
    contact: accountValue,
    field: accountValue,
    value: z.string().nullable().optional(),
    cdate: optionalString,
    udate: optionalString,
    created_by: nullableAccountValue,
    updated_by: nullableAccountValue,
    links: linksSchema.optional(),
    id: accountValue,
    owner: nullableAccountValue,
}).passthrough();

export type FieldValue = z.infer<typeof FieldValueSchema>;

export const GeoAddressSchema = z.record(z.string(), z.unknown());
export type GeoAddress = z.infer<typeof GeoAddressSchema>;

export const GeoIpSchema = z.record(z.string(), z.unknown());
export type GeoIp = z.infer<typeof GeoIpSchema>;

export const ContactInfoSchema = z.object({
    email: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
}).passthrough();

export type ContactInfo = z.infer<typeof ContactInfoSchema>;

export const ContactResponseSchema = z.object({
    contactAutomations: z.array(AutomationRunSchema).optional(),
    contactLists: z.array(ContactListSchema).optional(),
    deals: z.array(z.unknown()).optional(),
    fieldValues: z.array(FieldValueSchema).optional(),
    geoAddresses: z.array(GeoAddressSchema).optional(),
    geoIps: z.array(GeoIpSchema).optional(),
    contact: ContactInfoSchema,
}).passthrough();

export type Contact = z.infer<typeof ContactResponseSchema>;

export const FieldSchema = z.object({
    id: accountValue,
    title: z.string(),
    descript: z.string().nullable().optional(),
    type: optionalString,
    isrequired: nullableAccountValue,
    perstag: z.string(),
    defval: z.string().nullable().optional(),
    show_in_list: nullableAccountValue,
    rows: nullableAccountValue,
    cols: nullableAccountValue,
    visible: nullableAccountValue,
    service: optionalString,
    ordernum: nullableAccountValue,
    cdate: optionalString,
    udate: optionalString,
    options: z.array(z.unknown()).optional(),
    relations: z.array(z.unknown()).optional(),
    links: linksSchema.optional(),
}).passthrough();

export type Field = z.infer<typeof FieldSchema>;

export const ContactSearchResponseSchema = z.object({
    contacts: z.array(ShortenedContactSchema),
    meta: CollectionMetaSchema,
}).passthrough();

export type ContactSearchResponse = z.infer<typeof ContactSearchResponseSchema>;

export const FieldResponseSchema = z.object({
    fields: z.array(FieldSchema),
    meta: CollectionMetaSchema,
}).passthrough();

export type FieldResponse = z.infer<typeof FieldResponseSchema>;

export const FieldValuesResponseSchema = z.object({
    fieldValues: z.array(FieldValueSchema),
}).passthrough();

export type FieldValuesResponse = z.infer<typeof FieldValuesResponseSchema>;


// POSTMARK

export type PostmarkEmail = {
    From: string;
    To: string;
    Subject: string;
    TextBody: string;
    HtmlBody: string;
    MessageStream: string;
};

export type EmailSendResponse = {
    ErrorCode: number;
    Message: string;
    MessageID?: string;
    SubmittedAt?: string; // ISO 8601 timestamp
    To?: string;
};


// UTILS

export type ContactVariables = {
    ID: string;
    EMAIL: string;
    [KEY: string]: string;
    // Flexible type for contact variables
};
