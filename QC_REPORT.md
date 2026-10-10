# QC report

Final repo SHA: `9891763937bd9def69dc75c77fc30c657f956acc`.

## Fresh verification after final documentation update

Command run:

```bash
cd /d f:\job-feed-ingestion; npm run typecheck; npm test; npm run demo; npm run loadtest
```

Observed results:

- TypeScript: passed (`tsc --noEmit -p tsconfig.json`)
- Unit/integration tests: passed, 3 files / 11 tests
- Demo: passed; the fixture scenario sent the invalid event and replay case and completed the final job-state output
- Load: passed; local measured output was:
  - concurrency: 25
  - distinct accepts: 1100
  - exact replays: 200
  - errors: 0
  - p50 latency: 60.61 ms
  - p95 latency: 101.15 ms
  - queue drain: 10,916 ms
  - final jobs: 1050 / 1050
  - out-of-order jobs ending at version 2: 48 of 50

## Checks and evidence summary

- Docker Compose / MongoDB: the service was validated against a live local MongoDB instance on `127.0.0.1:27017`.
- Formatting/linting: not configured in `package.json`.
- Demo and load scripts: executed successfully without code changes after the final validation run.
- Failure hypotheses challenged:
  1. Worker loss leaves work stuck: the recovery logic was exercised in integration tests and reclaimed stale/abandoned processing.
  2. Concurrent duplicate POSTs create duplicate work: real MongoDB tests validated that duplicate requests produce one logical event and one job projection.
  3. Provider retry changes projection before verification: retry/success/failure cases were checked against the fixture plan and the event history.
  4. Documentation claims differ from implementation: README and QC findings were compared directly with actual behavior in the code and the run outputs.

Reviewed untrusted input validation, tenant/source scoping, provider fixture behavior, credentials (none committed), dependency scope, indexes, retry settings, API examples, and final-state checks. The repository is in a verified submission state at the recorded final SHA above.