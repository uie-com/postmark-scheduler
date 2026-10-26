import { getActiveContactsInAutomation, getAllContactVariables, getAutomationDetails, getTemplateDetails, listFields, parseTemplateContent } from "@/domain/actions/activecampaign";
import { getScheduledEmails, markEmailAsSent } from "@/domain/actions/airtable";
import { createBatchEmailArray, sendBatchEmail } from "@/domain/actions/postmark";
import { sendSlackMessage } from "@/domain/actions/slack";
import { sendError, tryAction } from "@/domain/error";
import { Automation, Email, EmailSendResponse, PostmarkEmail, Template } from "@/domain/types";
import { NextRequest, NextResponse } from "next/server";

let isPending = false;

export async function GET(request: NextRequest) {
    if (isPending) {
        console.log('[SEND] Another email send process is already running. Exiting this request.');
        return NextResponse.json({ message: 'Already Sending Emails' }, { status: 429 });
    }

    isPending = true;

    await sendEmails();

    isPending = false;

    return NextResponse.json({ status: 200 });
}

async function sendEmails() {
    console.log('\n\n\n\n');
    const emails = await tryAction<Email[]>(getScheduledEmails, 'Getting the list of ready-to-send emails', true);

    if (emails.length === 0) {
        console.log('[SEND] No emails to send at this time.');
        return NextResponse.json({ message: 'No emails to send.' }, { status: 200 });
    }

    const fields = await tryAction(() => listFields(), 'Listing ActiveCampaign fields', true);
    console.log(`[SEND] Found ${fields.length} ActiveCampaign fields.`);

    for (const email of emails) {
        try {
            console.log(`\n\n[SEND] Sending email '${email["Email ID"]}'. \nSubject: ${email.Subject} \nSchedule Date: ${email["Schedule Date"]}`);

            const automation = await tryAction<Automation>(() => getAutomationDetails(email["Automation ID"]), 'Getting automation details', true);

            const automationContacts = await tryAction(() => getActiveContactsInAutomation(email["Automation ID"]), 'Getting active contacts for automation', true);

            if (automationContacts.length === 0) {
                await sendError(`No active contacts found in automation '${automation.name}'.`);
                continue;
            }

            const template = await tryAction<Template>(() => getTemplateDetails(email["Template ID"]), 'Getting template details', true);

            const emailContent = await tryAction(() => parseTemplateContent(template), 'Parsing template content', true);

            console.log(`[SEND] Got HTML content for email '${email["Email ID"]}': ${emailContent.length} characters`);

            const variables = await tryAction(() => getAllContactVariables(automationContacts, fields), 'Getting all contact variables', true);

            const emailArray = await tryAction<PostmarkEmail[]>(() => createBatchEmailArray(automationContacts, email, emailContent, variables), 'Formatting batch email array', true);

            const sendResult = await tryAction<EmailSendResponse[]>(() => sendBatchEmail(emailArray), 'Sending email with Postmark', true);

            const successfulSends = sendResult.filter(result => result.ErrorCode === 0);
            console.log(`[SEND] Email '${email["Email ID"]}' sent successfully to ${successfulSends.length}/${automationContacts.length} recipients.`);

            const erroredSends = sendResult.filter(result => result.ErrorCode !== 0);
            const errorMessages = erroredSends.map(result => `Error sending to ${result.To}: ${result.Message}`).join('\n');

            if (erroredSends.length > 0) {
                console.error(`[SEND] Errors occurred while sending email '${email["Email ID"]}':\n${errorMessages}`);
            }

            await tryAction(() => markEmailAsSent(email["Airtable ID"]), `Marking email '${email["Email ID"]}' as sent in Airtable`, true);

            sendSlackMessage(`Email '${email["Email ID"]}' successfully sent to ${sendResult.length}/${automationContacts.length} recipients in '${automation.name}'.${erroredSends.length > 0 ? `\n${erroredSends.length} sends had errors.` : ''}`);

            console.log(`[SEND] Email '${email["Email ID"]}' processing completed.`);
        } catch (error: any) {
            console.error(`[SEND] Failed to send email '${email["Email ID"]}':`, error.message || error);
            await sendError(`Failed to send email '${email["Email ID"]}': \`${error.message || error}\``);
        }
    }
}