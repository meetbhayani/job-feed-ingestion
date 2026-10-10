# QC report

Final repo SHA: `9891763937bd9def69dc75c77fc30c657f956acc`.

## Fresh verification after final fixes

Command run:

```bash
cd /d f:\job-feed-ingestion; npm run typecheck; npm test; npm run demo; npm run loadtest
```

Observed results:

- TypeScript: passed (`tsc --noEmit -p tsconfig.json`)
- Unit/integration tests: passed, 3 files / 12 tests
- Demo: passed; the fixture scenario sent the invalid event and replay case and completed the final job-state output
- Load: passed; local measured output was:
  - concurrency: 25
  - distinct accepts: 1100
  - exact replays: 200
  - errors: 0
  - p50 latency: 61.28 ms
  - p95 latency: 92.97 ms
  - queue drain: 9,752 ms
  - final jobs: 1050 / 1050
  - out-of-order jobs ending at version 2: 50 of 50

## Checks and evidence summary

- Docker Compose / MongoDB: the service was validated against a live local MongoDB instance on `127.0.0.1:27017`.
- Formatting/linting: not configured in `package.json`.
- Demo and load scripts: executed successfully after the final correctness fixes.
- Failure hypotheses challenged:
  1. Worker loss leaves work stuck: the recovery logic was exercised in integration tests and reclaimed a stale claim without duplicating the job projection.
  2. Concurrent duplicate POSTs create duplicate work: real MongoDB tests validated that duplicate requests produce one logical event and one job projection.
  3. Provider retry changes projection before verification: retry, permanent-failure, and exhaustion cases were checked against the fixture plan and the event history.
  4. Documentation claims differ from implementation: README and QC findings were compared directly with actual behavior in the code and the final run outputs.

Reviewed untrusted input validation, tenant/source scoping, provider fixture behavior, credentials (none committed), dependency scope, indexes, retry settings, API examples, and final-state checks. The repository is in a verified submission state at the recorded final SHA above.