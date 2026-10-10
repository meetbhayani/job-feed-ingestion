# QC report

Date: 2026-10-10

Environment: Windows, `DESKTOP-FANPERU`, Node.js 26.1, npm, Docker Compose with MongoDB 7.

Verified code commit: `e2a7c74876f3ea41db4d0d285dba16b1b56ec10e`

The QC report is committed after the verified code commit. Its commit is the final repository HEAD; the exact final HEAD SHA is provided in the final handoff because embedding a commit's own hash in the file changes that hash.

The final user-run verification used `mongodb://127.0.0.1:27017/job_feed_ingestion_review`. The MongoDB container was healthy. The demo resets collections, so this isolated database was used for it as well. Earlier verification of the same code commit used a separate disposable database.

## Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Docker Compose setup | `docker compose up -d --wait` | Passed; MongoDB 7 container healthy. |
| Clean dependencies | `npm ci` | Passed; installed 168 packages. npm reported advisories, detailed below. |
| Strict TypeScript | `npm run typecheck` | Passed (`tsc --noEmit -p tsconfig.json`). |
| Unit and MongoDB integration tests | `npm test` with `MONGODB_URI=.../job_feed_ingestion_review` | Passed; 3 test files, 14 tests. Integration tests used the live local MongoDB service. |
| Fixture demo | `npm run demo` with `MONGODB_URI=.../job_feed_ingestion_review` | Passed; fixture phases completed, including expected invalid input and exact replay responses. |
| Complete load test | `npm run loadtest` with `MONGODB_URI=.../job_feed_ingestion_review` and minimum defaults | Passed; actual results below. |
| Load minimum guard | `$env:LOAD_COUNT='999'; npm run loadtest` | Rejected as expected with exit code 1 and `LOAD_COUNT must be at least 1000`; validation runs before connecting to MongoDB. |
| Diff whitespace | `git diff --check` | Passed. |
| Formatting/lint | Checked `package.json` scripts and root config files | Not configured; no formatter or linter command exists. |
| Production dependency audit | `npm audit --omit=dev` | Passed; 0 vulnerabilities. |
| Full dependency audit | `npm audit` | Failed with exit code 1: 6 advisories in development/test transitive dependencies (3 moderate, 1 high, 2 critical, including `tinypool`). npm's suggested fix requires a breaking Vitest 5 upgrade; dependencies were not changed outside the requested scope. |

### Measured load result

- Machine: `DESKTOP-FANPERU`
- MongoDB: `job_feed_ingestion_review` on local MongoDB 7
- Concurrency: 25
- Distinct accepted events: 1,100
- Exact replay requests handled: 200
- HTTP/network errors: 0
- HTTP p50: 39.68 ms
- HTTP p95: 62.96 ms
- Workload start to observed queue drain: 9,706 ms
- Events stored and completed: 1,100 / 1,100
- Expected logical jobs: 1,050; actual: 1,050
- Out-of-order jobs: 50; final version 2: 50 / 50
- Unrelated tenant probe: preserved
- Load-test run completed with the default `LOAD_PORT` (3100); no port override was required.

These are local development measurements, not production throughput claims.

## Correctness challenges

1. **Concurrent versions or archive/upsert leave a lower projection.** Real MongoDB integration tests race version 1 against version 2, and an upsert against a version-2 archive for a new identity. The final versions/statuses are correct and each logical identity has one job document. Duplicate-key handling re-reads the identity, treats equal/newer projections as stale, retries only an existing lower-version projection, and propagates unresolved errors.
2. **A crash after projection is only represented by manually prepared state.** The recovery test submits a real event, claims it through `processClaimedEvent()`, executes provider verification and the actual projection write, then throws before acknowledgment. It verifies the abandoned processing state, advances the same job to version 2, expires the old claim, and recovers version 1 as `stale-noop`. It checks both attempt histories, final version/title, completed statuses, and one logical job.
3. **Load cleanup can erase another tenant's data or hide bad final versions.** The load script uses a per-run UUID namespace, tenant-scoped cleanup only, submits version 2 before version 1 in separate awaited batches, compares complete expected and actual job identity sets, checks every out-of-order projection's version/status, and preserves a distinct tenant sentinel. Demo tenant records were separately counted before/after load and remained present.
4. **Scaling text presents a burst estimate as a measurement or drains against burst rather than baseline arrival.** `SCALE.md` labels estimates as theoretical, calculates backlog with the specified max formula, and drains against the ongoing 10-million/day rate. README load metrics were compared with the final script output.

## Implementation and documentation review

- README endpoint status examples match the Express routes and service behavior: 202 new acceptance, 200 exact replay, 409 identity conflict, 400 validation error, scoped event reads, cursor jobs pages, and MongoDB health readiness.
- Mongo indexes match `src/db.ts`: unique event `(tenantId, sourceId, eventId)`, claim scan `(processingStatus, availableAt, claimedAt)`, unique job `(tenantId, sourceId, externalJobId)`, and listing `(tenantId, sourceId, currentStatus, updatedAt)`.
- Retry configuration is three total attempts, with linear delay `RETRY_BACKOFF_MS × attemptCount` (default 1,000 ms); 429/503 retry and 422 is terminal. Scale notes distinguish these implemented settings from recommended jitter, per-tenant quotas, and admission/fairness controls that are not implemented.
- HTTPS validation uses URL parsing and `https:` protocol validation. Tests cover valid HTTPS, malformed URLs, HTTP, and an unsupported protocol. Other identifier, payload, normalization, and tenant/source identity rules remain covered.
- No credentials were found in project files; `.env` is ignored and `.env.example` documents configuration. Caller authentication is not implemented because the exercise treats tenant input as trusted.
- `SCALE.md` calculates 100k/day = 1.16 events/s and 10M/day = 115.74 events/s; models a 5,000 events/s burst; assumes 50 events/s per worker and an 80-worker/4,000 events/s example; shows backlog, net drain, five-minute target and storage estimates. TTL is explicitly not configured in this implementation.

## Scaling arithmetic

Planning assumptions, not measured service capacity:

- A 60-second 5,000 events/s burst with 4,000 events/s processing capacity accumulates `(5,000 - 4,000) × 60 = 60,000` events.
- At the 10M/day ongoing rate, drain is `60,000 / (4,000 - 115.74) = 15.45` seconds.
- For a five-minute burst, backlog is `(5,000 - 4,000) × 300 = 300,000`; drain at the 10M/day baseline is `300,000 / (4,000 - 115.74) = 77.23` seconds. The modeled FIFO tail wait is below five minutes under the stated steady-capacity/no-retry-storm assumptions.
- Raw 10M/day payload at 1 KB for seven days is 70 GB. With an assumed 30% metadata/index allowance and three data-bearing replica copies, the estimate is `70 × 1.3 × 3 = 273 GB`. One million 1 KB projections similarly estimate to `1 × 1.3 × 3 = 3.9 GB`. These allowances are approximate and exclude oplog, backups, reserve, and compression effects.

## Data-safety disclosure

An exploratory integration test was run before the verification database was isolated. It used the default `MONGODB_URI` database (`job_feed_ingestion`); the integration test setup calls `resetCollections()`, which deletes that database's `events` and `jobs` collections. I cannot determine whether those collections held user data or restore their pre-run contents without a backup. Later verification used isolated `job_feed_ingestion_submission_verify` and `job_feed_ingestion_review` databases. The load test itself uses only tenant-scoped cleanup and verified its unrelated tenant probe remained preserved.

## Remaining risks and limitations

- The full npm audit remains failing for development/test transitive packages, including critical `tinypool` advisories. Production dependencies audit clean. A major test-runner upgrade was not made within this focused task.
- Provider calls and any provider-side effects are at-least-once: recovery after projection but before acknowledgment can repeat provider verification if that version is still current. External side effects must be idempotent. The test's stale recovery case skips the provider because version 2 is already present.
- Admission control, per-tenant fairness, retry jitter/quotas, and TTL retention are scaling recommendations, not implemented runtime features.
- The default integration test helper and demo reset their configured database collections. Use a disposable database URI when running them; the final verification did so.
