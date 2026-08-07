import { getConfig } from "../config";
import { requestJson } from "../http";
import type { AirtableRecord, AirtableResponse } from "../types";
import { z } from "zod";

const AIRTABLE_API_URL = "https://api.airtable.com/v0";

export type AirtableSparseFields = Record<string, unknown>;

const airtableRecordSchema = z
    .object({
        id: z.string().min(1),
        fields: z.record(z.string(), z.unknown()),
        createdTime: z.string().min(1),
    })
    .passthrough();

const airtableListResponseSchema = z
    .object({
        records: z.array(airtableRecordSchema),
        offset: z.string().min(1).optional(),
    })
    .passthrough();

const airtableUpdateResponseSchema = z
    .object({
        records: z.array(airtableRecordSchema),
    })
    .passthrough();

const airtableDeleteResponseSchema = z
    .object({
        id: z.string().min(1),
        deleted: z.boolean(),
    })
    .passthrough();

type AirtableListPayload = z.infer<typeof airtableListResponseSchema>;
type AirtableRecordPayload = z.infer<typeof airtableRecordSchema>;
type AirtableUpdatePayload = z.infer<typeof airtableUpdateResponseSchema>;
type AirtableDeletePayload = z.infer<typeof airtableDeleteResponseSchema>;

function requirePathSegment(value: string, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }

    return encodeURIComponent(value.trim());
}

function airtableUrl(base: string, table: string, recordId?: string): string {
    const segments = [
        requirePathSegment(base, "Airtable base ID"),
        requirePathSegment(table, "Airtable table ID"),
    ];

    if (recordId !== undefined) {
        segments.push(requirePathSegment(recordId, "Airtable record ID"));
    }

    return `${AIRTABLE_API_URL}/${segments.join("/")}`;
}

function airtableHeaders(includeBody = false): HeadersInit {
    const { airtable } = getConfig();
    return {
        Authorization: `Bearer ${airtable.apiKey}`,
        Accept: "application/json",
        ...(includeBody ? { "Content-Type": "application/json" } : {}),
    };
}

function queryUrl(base: string, table: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    const url = airtableUrl(base, table);
    return query ? `${url}?${query}` : url;
}

export async function fetchAirtableRecords(
    base: string,
    table: string,
    params: Record<string, string> = {},
): Promise<AirtableResponse<AirtableSparseFields>> {
    const payload = await requestJson<AirtableListPayload>({
        provider: "Airtable",
        operation: "list records",
        url: queryUrl(base, table, params),
        init: {
            headers: airtableHeaders(),
            cache: "no-store",
        },
        schema: airtableListResponseSchema,
    });

    return payload;
}

export async function fetchAllAirtableRecords(
    base: string,
    table: string,
    params: Record<string, string> = {},
): Promise<AirtableRecord<AirtableSparseFields>[]> {
    const records: AirtableRecord<AirtableSparseFields>[] = [];
    let offset: string | undefined;

    do {
        const pageParams = offset === undefined ? { ...params } : { ...params, offset };
        const data = await fetchAirtableRecords(base, table, pageParams);
        records.push(...data.records);
        offset = data.offset;
    } while (offset);

    return records;
}

export async function fetchAirtableRecordById(
    base: string,
    table: string,
    id: string,
): Promise<AirtableRecord<AirtableSparseFields>> {
    const payload = await requestJson<AirtableRecordPayload>({
        provider: "Airtable",
        operation: "get record",
        url: airtableUrl(base, table, id),
        init: {
            headers: airtableHeaders(),
            cache: "no-store",
        },
        schema: airtableRecordSchema,
    });

    return payload;
}

export async function createAirtableRecord(
    base: string,
    table: string,
    fields: AirtableSparseFields,
): Promise<AirtableRecord<AirtableSparseFields>> {
    const payload = await requestJson<AirtableRecordPayload>({
        provider: "Airtable",
        operation: "create record",
        url: airtableUrl(base, table),
        init: {
            method: "POST",
            headers: airtableHeaders(true),
            body: JSON.stringify({ fields }),
        },
        schema: airtableRecordSchema,
    });

    return payload;
}

export async function updateAirtableRecord(
    base: string,
    table: string,
    id: string,
    fields: AirtableSparseFields,
): Promise<AirtableResponse<AirtableSparseFields>> {
    requirePathSegment(id, "Airtable record ID");
    const payload = await requestJson<AirtableUpdatePayload>({
        provider: "Airtable",
        operation: "update record",
        url: airtableUrl(base, table),
        init: {
            method: "PATCH",
            headers: airtableHeaders(true),
            body: JSON.stringify({ records: [{ id, fields }], typecast: true }),
        },
        schema: airtableUpdateResponseSchema,
    });

    return payload;
}

export async function deleteAirtableRecord(
    base: string,
    table: string,
    id: string,
): Promise<{ id: string; deleted: boolean }> {
    const payload = await requestJson<AirtableDeletePayload>({
        provider: "Airtable",
        operation: "delete record",
        url: airtableUrl(base, table, id),
        init: {
            method: "DELETE",
            headers: airtableHeaders(),
        },
        schema: airtableDeleteResponseSchema,
    });

    return payload;
}
