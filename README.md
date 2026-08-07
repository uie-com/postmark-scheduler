# Postmark Scheduler

Postmark Scheduler coordinates scheduled email work across Airtable, ActiveCampaign, Postmark, and Slack. Airtable is the durable queue and state store. ActiveCampaign supplies the audience and template content. Postmark performs delivery.

The service does not provide strict exactly-once delivery or idempotence across replicas. Run one production executor at a time. Each provider request is made once per execution unit; an ambiguous provider result is never silently retried.

## Runtime surface

The service exposes four workers and one coordinator:

- `GET /ping` starts metadata, test, production, and warning workers, waits for them, and returns a run summary: `{ runId, state, workers }`. It does not self-dispatch through `APP_URL` or return before the workers finish.
- `GET /updateMetadata` refreshes human-readable ActiveCampaign names in Airtable.
- `GET /testEmails` processes rows ready for a test send.
- `GET /sendEmails` processes rows ready for production delivery.
- `GET /sendWarnings` sends late-review and late-send notifications.
- `GET /api/progress?runId=<id>` returns an ephemeral run snapshot. A request without `runId` returns up to 25 recent snapshots. Snapshots include `ephemeral: true`, worker states (`queued`, `running`, `succeeded`, `partial`, `failed`, or `busy`), and up to 200 bounded sanitized events. They are for live visibility only; a restart or another replica can discard them.

The durable source of truth is the Airtable row. The progress API and in-memory run records are not an audit log.

## Execution and retry policy

Production and test rows are claimed in Airtable before a provider side effect. A successful provider response moves the row to its success state. A known provider rejection or a failure before submission can move it to a safe failed state. A lost response, timeout after submission, malformed response, or any other uncertain result moves it to an outcome-unknown state.

There are no progressive provider retries inside an HTTP handler. The current selectors do not pick up `Send Failed` or `Test Failed`; an operator must verify that no provider side effect occurred and explicitly requeue a safe failure to `Ready to Send` or `Needs Testing`. Rows in `Sending`, `Send Outcome Unknown`, `Testing`, or `Test Outcome Unknown` are excluded from automatic retry.

Before retrying or changing any of those intermediate/ambiguous rows, reconcile the provider activity and Airtable record manually. If a provider accepted the request, record the corresponding success; if it did not, move the row to a safe failed state and explicitly requeue it before a later tick. Never reset an ambiguous row blindly.

Use a single production executor. Airtable claims reduce accidental overlap, but multiple running replicas are not a distributed exactly-once lock.

## Run states

Production states:

`Draft` → `Needs Testing` → `Under QA Review` → `Ready to Send` → `Sending` → `Sent`

Known production outcomes are `Sent with Errors`, `Send Failed`, and `Send Outcome Unknown`. `Sent with Errors` means Postmark returned a known per-recipient partial result. `Send Outcome Unknown` means the request may have been accepted and requires reconciliation before any retry.

Test states:

`Needs Testing` → `Testing` → `Under QA Review`

Known test outcomes are `Tested with Errors`, `Test Failed`, and `Test Outcome Unknown`. The same reconciliation rule applies to `Testing` and `Test Outcome Unknown`.

## Airtable schema

Field names are exact and case-sensitive. Create the following fields in the scheduler table.

### Required queue and message fields

| Field | Type | Use |
|---|---|---|
| `Email ID` | Single line text | Human-readable row identifier. |
| `Template ID` | Single line text | ActiveCampaign template ID. |
| `Automation ID` | Single line text | ActiveCampaign automation ID. Test sends use `TEST_AUTOMATION` instead. |
| `Subject` | Single line text | Base subject; test sends add the test number and schedule context. |
| `Schedule Date` | Date/time | Earliest production-send time. |
| `Status` | Single select/text | Uses the states listed above. |
| `Test Number` | Number | Incremented after a fully successful test delivery. Blank values are treated as zero. |
| `Email Tag` | Single line text | Optional Postmark tag. |

### Metadata fields

Metadata selection uses these exact fields:

| Field | Type | Use |
|---|---|---|
| `Email Last Modified` | Last modified time/date | The source timestamp used to detect ID changes. |
| `Metadata Last Populated` | Last modified time/date | Configure this Airtable field to watch `Automation Name` and `Template Name`; Airtable advances it when `/updateMetadata` writes those fields. |
| `Automation Name` | Single line text | Written by `/updateMetadata`. |
| `Template Name` | Single line text | Written by `/updateMetadata`. |

The metadata worker selects non-draft, non-sent rows where `Email Last Modified` is after `Metadata Last Populated`, or where `Metadata Last Populated` is blank. There are no `Template`, `Automation`, or generic `Last Modified` fields in this contract.

### Delivery and warning fields

| Field | Type | Use |
|---|---|---|
| `Sent At` | Date/time | Written when production delivery is fully successful. |
| `Tested At` | Date/time | Written only when a test delivery completes fully successfully. |
| `Warnings` | Long text/single line text | JSON object mapping warning names to the last successful notification timestamp, for example `{"Late QA":"2026-08-05T15:00:00.000Z"}`. Malformed entries are ignored and reported. |

The warning worker uses the `Late QA` and `Late Send` keys and applies the two-hour cooldown in `domain/settings.ts`. A warning marker is persisted only after Slack accepts the notification.

`Airtable ID` means the record ID returned by Airtable; it is not a column.

## Configuration

Copy `.env.example` to `.env.local` and replace every placeholder. Keep credentials in a secret manager in production. `.env.example` contains placeholders only.

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL for links and runtime visibility. It is not a worker self-dispatch dependency. |
| `SLACK_WEBHOOK_URL` | Slack Workflow trigger URL used for notifications. |
| `AIRTABLE_API_KEY` | Airtable personal access token with read/write access. |
| `AIRTABLE_BASE_ID` | Airtable base ID. |
| `AIRTABLE_TABLE_ID` | Airtable scheduler table ID. |
| `ACTIVECAMPAIGN_API_KEY` | ActiveCampaign API token. |
| `ACTIVECAMPAIGN_API_URL` | ActiveCampaign account root or an URL ending in `/api/3`; runtime normalization produces exactly one `/api/3` suffix. Do not include credentials, query strings, or fragments. |
| `POSTMARK_API_KEY` | Postmark server token. |

Runtime settings in `domain/settings.ts` include `TEST_AUTOMATION` (`272`), `FROM_EMAIL`, `MESSAGE_STREAM` (`outbound`), worker status names, and the warning cooldown. `FROM_EMAIL` must be a registered Postmark Sender Signature before any send is attempted.

## Local setup

```bash
npm ci
cp .env.example .env.local
# Fill in .env.local with real deployment values.
npm test
npm run check
npm run build
npm run dev
```

The development server listens on port `5555`. A scheduler can call `GET /ping`; that request has side effects and should be protected by the deployment boundary.

## Operations and compliance

- Keep one production executor active at a time.
- Reconcile `Sending`, `Send Outcome Unknown`, `Testing`, and `Test Outcome Unknown` rows manually before changing them.
- Treat Airtable status and timestamps as durable state; treat progress snapshots as ephemeral.
- Do not assume a failed HTTP response means that Postmark did not accept a request.
- Protect provider credentials and side-effecting routes.
- Ensure contacts are permissioned, honor unsubscribe requirements, and follow provider rate limits and terms.
