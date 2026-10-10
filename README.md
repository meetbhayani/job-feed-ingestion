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

Fresh local verification on 2026-10-10 using Docker MongoDB on `DESKTOP-FANPERU`: concurrency 25; 1,100 distinct accepts; 200 exact replays; 0 errors; HTTP p50 61.28 ms; p95 92.97 ms; queue drain 9.75 s; 1,050/1,050 final jobs; all 50 out-of-order jobs ended at version 2. These local results are not production-capacity claims.
