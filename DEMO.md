# Demo

## Prerequisites and setup

Use Node.js 22 or newer, npm, and Docker with the Compose daemon running. From the repository root:

```sh
docker compose up -d --wait
npm ci
```

**Destructive behavior:** `npm run demo` calls `resetCollections()` and deletes all documents from the `events` and `jobs` collections in the configured MongoDB database. Do not point it at a shared or production database. Use a dedicated disposable database. In PowerShell:

```powershell
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/job_feed_ingestion_demo'
npm run demo
```

The service reads `PORT` from the environment and defaults to 3000. MongoDB defaults to `mongodb://127.0.0.1:27017/job_feed_ingestion`; the command above overrides it for the demo.

## Scenario and expected results

The script reads `fixtures/demo-scenario.json`, submits phase 1 in fixture order, waits for its events to settle, then submits phase 2 and waits again. Provider outcomes come from `fixtures/provider-plan.json`.

- Valid new events are accepted with HTTP 202.
- The malformed HTTP URL event (`event-110`) is rejected with HTTP 400.
- The repeated exact `event-111` request returns HTTP 200.
- The final jobs query returns HTTP 200. For `tenant-a`, `alpha` ends active at version 7 after archive and reopen events; `archive-job` remains an archived version-5 tombstone. Other fixture jobs remain scoped by their tenant/source identities.

The script prints each POST status and event ID, followed by the final job projection response. A provider-rejected event may still have been durably accepted with HTTP 202; its terminal processing outcome is visible in event state.