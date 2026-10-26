import { FETCH_DELAY_SEC, SHORT_FETCH_DELAY_SEC } from "../settings";
import { Automation, AutomationResponse, AutomationRun, AutomationRunResponse, Contact, ContactVariables, Field, FieldValue, ShortenedContact, Template, TemplateResponse } from "../types";

const API_URL = process.env.ACTIVECAMPAIGN_API_URL ?? '';
const API_KEY = process.env.ACTIVECAMPAIGN_API_KEY ?? '';

// TEMPLATES

export async function parseTemplateContent(template: Template): Promise<string> {
    let content = template.preview_content;

    // Remove AC footer.
    content = content.replace(/<table class="es-footer ac-footer[\s\S]*?<\/table>/gi, '');

    return content;
}

export async function getTemplateDetails(templateId: string): Promise<Template> {
    console.log(`[AC] Fetching template contents for ID: ${templateId}`);

    return (await fetch(`${API_URL}/templates/${templateId}`, {
        headers: {
            "Content-Type": "application/json",
            "Api-Token": API_KEY,
        },
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error fetching template contents: ${response.statusText}`);
            }
            return response.json() as Promise<TemplateResponse>;
        })).template as Template;

}

export function fillContentVariables(content: string, variables: ContactVariables) {
    let filledTemplate = content;

    for (const key in variables) {
        if (Object.hasOwnProperty.call(variables, key)) {
            const placeholder = new RegExp(`%${key}%`, 'g'); // Create a regex for %variableName%
            filledTemplate = filledTemplate.replace(placeholder, variables[key]);
        }
    }

    filledTemplate = filledTemplate.replace(/%([A-Z0-9_-]+)%/gi, (match, key) => {
        console.warn('[WARN] Found variable with no value: ' + match + ' for contact ' + variables.EMAIL);
        return '';
    });

    return filledTemplate;
}

//


// AUTOMATIONS

export async function getActiveContactsInAutomation(automationId: string): Promise<ShortenedContact[]> {

    const allContacts = await getAllContactsForAutomation(automationId);
    const runs = await getAutomationRuns(automationId);

    const activeRuns = runs.filter(run => run.completed === 0);

    const activeContacts = allContacts.filter(contact => {
        return activeRuns.some(run => run.contact === contact.id);
    });

    const missingContacts = allContacts.filter(contact => {
        return !runs.some(run => run.contact === contact.id);
    });
    if (missingContacts.length > 0) {
        console.warn(`[AC] Found ${missingContacts.length} contacts that are missing from automation runs.`);
    }

    console.log(`[AC] Cross-referenced ${activeContacts.length} active contacts in automation ID: ${automationId}`);

    return activeContacts;
}

export async function getAutomationDetails(automationID: string): Promise<Automation> {
    console.log(`[AC] Fetching automation details for ID: ${automationID}`);

    return (await fetch(`${API_URL}/automations/${automationID}`, {
        headers: {
            "Content-Type": "application/json",
            "Api-Token": API_KEY,
        },
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error fetching automation details: ${response.statusText}`);
            }
            return response.json() as Promise<AutomationResponse>;
        })).automation as Automation;
}

export async function getAutomationRuns(automationId: string): Promise<AutomationRun[]> {
    console.log(`[AC] Fetching runs inside automation ID: ${automationId}`);

    const automationRuns = (await fetch(API_URL + '/automations/' + automationId + '/contactAutomations', {
        headers: {
            "Content-Type": "application/json",
            "Api-Token": API_KEY,
        },
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error fetching contacts for automation: ${response.statusText}`);
            }
            return response.json();
        }) as AutomationRunResponse).contactAutomations;

    console.log(`[AC] Fetched ${automationRuns.length} automation runs.`);

    return automationRuns;
}

export async function getAllContactsForAutomation(automationId: string): Promise<ShortenedContact[]> {
    console.log(`[AC] Fetching contacts inside automation ID: ${automationId}`);

    const contacts = await paginatedFetch<ShortenedContact>(`${API_URL}/contacts`, 'contacts', {
        seriesid: automationId
    });

    console.log(`[AC] Found ${contacts.length} contacts.`);

    return contacts;
}

//

// CONTACTS

export async function listFields(): Promise<Field[]> {
    let fields: Field[] = [];

    fields = await paginatedFetch<Field>(`${API_URL}/fields`, 'fields')

    return fields;
}

export async function getContactDetails(contactId: string): Promise<Contact> {
    console.log(`[AC] Fetching contact details for ID: ${contactId}`);

    return await fetch(`${API_URL}/contacts/${contactId}`, {
        headers: {
            "Content-Type": "application/json",
            "Api-Token": API_KEY,
        },
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error fetching contact details: ${response.statusText}`);
            }
            return response.json();
        });
}

export async function getContactFieldValues(contactId: string): Promise<FieldValue[]> {
    console.log(`[AC] Fetching contact fields for ID: ${contactId}`);

    return (await fetch(`${API_URL}/contacts/${contactId}/fieldValues`, {
        headers: {
            "Content-Type": "application/json",
            "Api-Token": API_KEY,
        },
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error fetching contact details: ${response.statusText}`);
            }
            return response.json();
        })).fieldValues as FieldValue[];
}


export async function getContactVariables(contact: ShortenedContact, fields: Field[], includeCustom: boolean = false): Promise<ContactVariables> {
    console.log(`[AC] Fetching contact variables for ID: ${contact.id}`);

    let fieldValues;

    if (includeCustom)
        fieldValues = await getContactFieldValues(contact.id);

    const variables: ContactVariables = {
        ID: contact.id,
        EMAIL: contact.email,
    };

    if (includeCustom && fieldValues)
        fieldValues.forEach(fieldValue => {
            const key = fields.find(f => f.id === fieldValue.field);
            if (!key)
                return console.warn('[WARN] Unknown field value ' + fieldValue.value + ' for contact ' + contact.id);
            variables[key.perstag.toUpperCase()] = fieldValue.value;
        });

    Object.keys(contact).forEach(contactKey => {
        if (typeof contact[contactKey as keyof ShortenedContact] === 'string')
            variables[contactKey.toUpperCase()] = contact[contactKey as keyof ShortenedContact];
    });

    return variables;
}

export async function getAllContactVariables(contacts: ShortenedContact[], fields: Field[], includeCustom: boolean = false) {
    const contactVariables: ContactVariables[] = [];
    for (const contact of contacts) {
        contactVariables.concat(await getContactVariables(contact, fields, includeCustom));
        await new Promise(resolve => setTimeout(resolve, SHORT_FETCH_DELAY_SEC * 1000)); // Throttle requests
    }
    return contactVariables;
}


//


// UTILS

export async function paginatedFetch<T>(url: string, key: string, params?: any, limit: number = 50): Promise<T[]> {
    let results: T[] = [];
    let nextOffset = 0;
    let total = 0;

    do {
        const queryParams = new URLSearchParams({
            offset: nextOffset.toString(),
            limit: limit.toString(),
            ...params
        });

        const response = await fetch(`${url}?${queryParams}`, {
            headers: {
                "Content-Type": "application/json",
                "Api-Token": API_KEY,
            },
        });

        if (!response.ok) {
            throw new Error(`Error fetching data: ${response.statusText}`);
        }

        const data = await response.json();
        results = results.concat(data[key]); // Adjust based on actual structure
        total = parseInt(data.meta.total) || 0; // Adjust based on actual structure
        nextOffset += limit;

        await new Promise(resolve => setTimeout(resolve, FETCH_DELAY_SEC * 1000)); // Throttle requests

    } while (nextOffset < total);

    return results;
}