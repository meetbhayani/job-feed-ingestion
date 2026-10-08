# Design

`POST /events` validates/normalizes input and inserts an `events` document before returning 202. Two worker loops atomically claim available work with MongoDB `findOneAndUpdate`. Non-stale events use the fixture provider, then conditionally update `jobs`, then receive a completion acknowledgement.

Invariants: event identity is `(tenantId, sourceId, eventId)`; job identity is `(tenantId, sourceId, externalJobId)`; only strictly greater versions update a projection. Archives persist an archived versioned tombstone. Event records retain attempts, history, error, claim and availability data. Statuses are pending, processing, completed, failed; stale-noop is an attempt outcome.

Indexes: unique event identity; claim scan `(processingStatus, availableAt, claimedAt)`; unique job identity; tenant/source/status/updated-time job listing. A worker claims pending due work or an expired processing claim and increments attempts. Thus crashes consume an attempt: a durable claim happened and recovery remains visible. 429/503 retry with increasing configured delay up to three total attempts; 422 is terminal. Stale events skip provider verification.

Acceptance survives a crash because insertion precedes 202. Projection and completion acknowledgement are separate: a crash after projection may repeat verification, but guarded version projection is safe. Completion cannot undo a projection. Provider calls are at-least-once, not exactly-once.

Mongo-only queueing is a deliberate time-boxed tradeoff; polling/claim scans are the likely first bottleneck. Redis/Kafka were rejected because they add a durable system outside scope. Transactions were rejected because guarded single-document updates meet required projection safety with less complexity. In production, credentials would authenticate callers and authorize tenant scope rather than trust tenant IDs.