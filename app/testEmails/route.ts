import { getActiveContactsInAutomation, getAllContactVariables, getAutomationDetails, getTemplateDetails, listFields, parseTemplateContent } from "@/domain/actions/activecampaign";
import { getTestEmails, markEmailAsTested } from "@/domain/actions/airtable";
import { createBatchEmailArray, sendBatchEmail } from "@/domain/actions/postmark";
import { sendError, tryAction } from "@/domain/error";
import { TEST_AUTOMATION } from "@/domain/settings";
import { Automation, Email, EmailSendResponse, PostmarkEmail, Template } from "@/domain/types";
import { NextRequest, NextResponse } from "next/server";

let isPending = false;

export async function GET(request: NextRequest) {
    if (isPending) {
        console.log('[TEST] Another email send process is already running. Exiting this request.');
        return NextResponse.json({ message: 'Already Testing Emails' }, { status: 429 });
    }

    isPending = true;

    await testEmails();

    isPending = false;

    return NextResponse.json({ status: 200 });
}

async function testEmails() {
    console.log('\n\n\n\n');
    const emails = await tryAction<Email[]>(getTestEmails, 'Getting the list of ready-to-test emails', false);

    if (emails.length === 0) {
        console.log('[TEST] No emails to test at this time.');
        return;
    }

    const fields = await tryAction(() => listFields(), 'Listing ActiveCampaign fields', false);
    console.log(`[TEST] Found ${fields.length} ActiveCampaign fields.`);

    for (const email of emails) {
        try {

            console.log(`\n\n[TEST] Sending email '${email["Email ID"]}'. \nSubject: ${email.Subject} \nSchedule Date: ${email["Schedule Date"]}`);
            email["Automation ID"] = TEST_AUTOMATION;
            const sendDate = new Date(email["Schedule Date"]);


            const testNumber = parseInt(email["Test Number"] + '')

            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/New_York",
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                hour12: true
            }).formatToParts(sendDate);

            const month = parts.find(p => p.type === "month")?.value;
            const day = parts.find(p => p.type === "day")?.value;
            const hour = parts.find(p => p.type === "hour")?.value;
            const dayPeriod = parts.find(p => p.type === "dayPeriod")?.value;

            let sendDateStr = `${month}-${day} ${hour}${dayPeriod}`;

            if (sendDate < new Date())
                sendDateStr = `ASAP`;

            email.Subject = `TEST #${testNumber}: [${sendDateStr}] ${email.Subject}`;
            console.log(`[TEST] Constructed subject: ${email.Subject}`);

            const automation = await tryAction<Automation>(() => getAutomationDetails(TEST_AUTOMATION), 'Getting automation details', false);

            const automationContacts = await tryAction(() => getActiveContactsInAutomation(TEST_AUTOMATION), 'Getting active contacts for automation', false);

            if (automationContacts.length === 0) {
                await sendError(`No active contacts found in automation '${automation.name}'.`);
                continue;
            }

            const template = await tryAction<Template>(() => getTemplateDetails(email["Template ID"]), 'Getting template details', false);

            const emailContent = await tryAction(() => parseTemplateContent(template), 'Parsing template content', false);

            console.log(`[TEST] Got HTML content for email '${email["Email ID"]}': ${emailContent.length} characters`);

            const variables = await tryAction(() => getAllContactVariables(automationContacts, fields), 'Getting all contact variables', false);

            const emailArray = await tryAction<PostmarkEmail[]>(() => createBatchEmailArray(automationContacts, email, emailContent, variables), 'Formatting batch email array', false);

            const sendResult = await tryAction<EmailSendResponse[]>(() => sendBatchEmail(emailArray), 'Sending email with Postmark', false);

            const successfulSends = sendResult.filter(result => result.ErrorCode === 0);
            console.log(`[TEST] Email '${email["Email ID"]}' sent successfully to ${successfulSends.length}/${automationContacts.length} recipients.`);

            const erroredSends = sendResult.filter(result => result.ErrorCode !== 0);
            const errorMessages = erroredSends.map(result => `Error sending to ${result.To}: ${result.Message}`).join('\n');

            if (erroredSends.length > 0) {
                console.error(`[TEST] Errors occurred while testing email '${email["Email ID"]}':\n${errorMessages}`);
            }

            await tryAction(() => markEmailAsTested(email["Airtable ID"], testNumber), `Marking email '${email["Email ID"]}' as tested in Airtable`, false);

            console.log(`[TEST] Email '${email["Email ID"]}' processing completed.`);
        } catch (error: any) {
            console.error(`[TEST] Failed to send test email '${email["Email ID"]}':`, error.message || error);
            // await sendError(`Failed to send test email '${email["Email ID"]}': \`${error.message || error}\``);
        }
    }
}
