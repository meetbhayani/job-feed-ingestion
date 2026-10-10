# Job feed ingestion

Small Node.js/TypeScript service that durably accepts job-feed events in MongoDB and processes them asynchronously into a version-safe job projection.

## Architecture

`POST /events` validates and normalizes one event, inserts it into MongoDB, and returns. Two worker loops atomically claim MongoDB events, verify non-stale work through the fixture-driven fake provider, and conditionally update the job projection. MongoDB is the only queue and database.

## Prerequisites

Node.js 22+, Docker Desktop with the daemon running, and npm.

## Setup

One setup command:

```sh
docker compose up -d && npm ci
```

Copy `.env.example` to `.env` if defaults are unsuitable. `MONGODB_URI` defaults to `mongodb://127.0.0.1:27017/job_feed_ingestion`; `WORKER_COUNT` defaults to 2; `CLAIM_TIMEOUT_MS` and `RETRY_BACKOFF_MS` default to 5000 and 1000 respectively.

**Demo safety:** `npm run demo` clears all documents in the configured `events` and `jobs` collections before running. Set `MONGODB_URI` to a dedicated disposable database first; do not use a shared or production database. See DEMO.md for the scenario and expected results.

## Commands

```sh
npm run dev       # API plus two worker loops
npm run typecheck
npm test
npm run demo      # supplied fixture scenario
npm run loadtest  # local required workload
```

## APIs

- `POST /events` returns 202 after durable acceptance, 200 for an exact normalized replay, 409 for reused identity with different content, and 400 for invalid input.
- `GET /events/:eventId?tenantId=...&sourceId=...` returns scoped processing state, attempts and error detail.
- `GET /jobs?tenantId=...&sourceId=...&status=active|archived|all&limit=20&cursor=...` returns deterministic cursor pages. Pages are not snapshots: projection updates between requests can move records relative to the cursor.
- `GET /health` returns readiness based on MongoDB ping.

Events are uniquely keyed by tenant/source/event ID. Job projections are uniquely keyed by tenant/source/external job ID. Identifier whitespace is rejected; display fields and skills are normalized.

## Limitations

Processing is durable and idempotent at the projection boundary, not exactly-once. A provider success followed by a process crash can result in another verification call. No authentication is implemented because the exercise defines tenant input as trusted. See DESIGN.md and SCALE.md.

## Load result

Fresh local verification on 2026-10-11 using Docker MongoDB 7 on `DESKTOP-FANPERU` and disposable database `job_feed_ingestion_final_submission`: concurrency 25; 1,100 distinct accepts; 200 exact replays; 0 errors; HTTP p50 61.7182 ms; p95 89.6925 ms; queue drain 14,496 ms; 1,050 expected and actual jobs; 1,100 actual events; all 50 out-of-order jobs ended at version 2; unrelated tenant probe preserved. The script enforces at least 1,000 distinct events, 200 replays, and 50 out-of-order jobs, scopes cleanup to UUID-namespaced test tenants, and verifies an unrelated tenant probe remains unchanged. These local results are not production-capacity claims. The previous supplied 2026-10-10 run measured p50 41.6432 ms, p95 70.7062 ms, and 10,463 ms queue drain.
