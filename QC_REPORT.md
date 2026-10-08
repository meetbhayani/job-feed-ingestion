# QC report

Final revision: working tree (no Git metadata was present, so a commit SHA cannot be truthfully recorded).

## Checks after final changes

- Docker Compose: MongoDB 7 container started and reachable on localhost:27017.
- TypeScript: `npm.cmd run typecheck` — passed.
- Executable tests: `npm.cmd test` — passed, 3 files / 11 tests, using real Docker MongoDB.
- Demo: `npm.cmd run demo` — passed. The supplied two-phase fixture returned its expected 400 invalid event and 200 exact replay; accepted items settled and final projections were printed.
- Load: `npm.cmd run loadtest` — passed. Host `DESKTOP-FANPERU`; concurrency 25; 1,100 accepts, 200 replays, 0 errors; p50 51.63 ms, p95 73.85 ms, drain 9.03 s; 1,050 expected/actual jobs and 50/50 version-2 out-of-order projections.
- Formatting/linting: not configured in `package.json`.

## Failure hypotheses challenged

1. Worker loss leaves work stuck: the recovery test claims an event as a stopped worker, waits through its visibility timeout, reclaims it, and confirms exactly one correct projection.
2. Concurrent duplicate POSTs create duplicate work/projections: a real-Mongo test submits ten requests concurrently and finds one event/job.
3. A provider retry changes projection before verification: retry-success, 422, and exhaustion tests verify processing history/status and no failed projection.
4. Documentation claims differ from implementation: README settings/endpoints and measured load figures were compared with source/script; DESIGN claims at-least-once provider effects rather than exactly-once.

Reviewed untrusted input validation, tenant/source scope, provider fixture data, credentials (none committed), dependency scope, indexes, retry settings, API examples, and final-state checks. The assignment-required Git commits cannot be created until this directory is initialized as a Git repository.