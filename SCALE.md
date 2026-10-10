# Scale notes

These are theoretical planning calculations, not measured benchmark claims. The current local load-test numbers describe one development machine and must not be treated as worker-capacity benchmarks.

## 1. Arrival-rate assumptions

Average daily throughput is:

- 100,000 events/day = 100,000 / 86,400 = 1.16 events/s average
- 10,000,000 events/day = 10,000,000 / 86,400 = 115.74 events/s average

The steady-state workload is far below the assignment burst target. For explicit calculations below, assume a 5,000 events/s burst lasts 60 seconds (one minute). The burst accepts 300,000 events in total before accounting for concurrent processing.

## 2. Worker-capacity assumptions

The service does four things per event:

1. Insert the event durably into MongoDB.
2. Atomically claim the next available event.
3. Evaluate provider verification for that version.
4. Conditionally update the tenant/source/job projection with version safety.

For planning only, assume one worker can process 50 accepted events/s when MongoDB and provider verification are not saturated. An 80-worker pool therefore has assumed capacity:

80 workers × 50 events/s/worker = 4,000 events/s

To sustain 5,000 events/s with no backlog growth requires at least 100 workers at this assumed per-worker rate: 5,000 / 50 = 100. A 125-worker pool would provide a theoretical 6,250 events/s, leaving 1,250 events/s or 25% capacity headroom above the target. Retries, tenant skew, and MongoDB contention reduce effective capacity, so this arithmetic is a sizing assumption that must be benchmarked before deployment.

## 3. Backlog and drain-time calculations

Use the assignment formula with burst arrival rate $\lambda_b$, processing capacity $\mu$, and burst duration $T$:

`Backlog = max(0, arrival rate - processing capacity) × burst duration`

Equivalently, backlog = max(0, $\lambda_b$ - $\mu$) × $T$.

For the 60-second burst and the assumed 4,000 events/s pool:

(5,000 - 4,000) events/s × 60 s = 60,000 queued events

After the burst, use the ongoing arrival rate $\lambda_o$ and only calculate drain when $\mu > \lambda_o$:

Drain time = backlog / ($\mu$ - $\lambda_o$)

At 10 million events/day, ongoing arrivals are 115.74 events/s, so:

60,000 / (4,000 - 115.74) = 15.45 seconds

The denominator is positive, so the queue drains. If processing capacity is at or below 115.74 events/s, the backlog will not drain while that arrival rate continues.

### Five-minute accepted-event target

For a deliberately conservative five-minute burst at 5,000 events/s, backlog accumulation with the same 4,000 events/s pool is:

(5,000 - 4,000) events/s × 300 s = 300,000 events

Afterward, under the 10-million/day ongoing arrival rate, the drain time is:

`Drain time = backlog ÷ (processing capacity - ongoing arrival rate)`

300,000 / (4,000 - 115.74) = 77.23 seconds

Under these assumptions, the backlog created by that five-minute burst drains in about 77 seconds after burst arrivals return to baseline. For a FIFO-like queue, the maximum wait for work at the tail at the end of this burst is bounded by that drain interval, so the modeled burst remains within the five-minute accepted-event target. This assumes stable 4,000 events/s effective capacity, no sustained provider outage, and no additional retry amplification. Actual per-event latency must still be verified under production-like load; this planning calculation is not a measured SLA.

## 4. Storage assumptions

The assignment specifies:

- raw event payload average = 1 KB
- raw events retained for 7 days
- approximately 1,000,000 current job projections

Using decimal units (1 KB = 1,000 bytes), raw payload storage is:

- 100,000 events/day × 1 KB = 100 MB/day
- 7-day retention = 700 MB before indexes and replication

At 10,000,000 events/day:

- 10,000,000 × 1 KB = 10 GB/day
- 7-day retention = 70 GB before indexes and replication

For job projections, assume each of approximately one million current job documents averages 1 KB before indexes:

1,000,000 jobs × 1 KB = 1 GB of projection document data

For a rough capacity estimate, apply an explicitly assumed 30% allowance for document metadata and indexes, then multiply by three data-bearing replica-set members (one primary and two secondaries). The 70 GB raw payload estimate becomes 70 × 1.3 = 91 GB per full dataset copy, or approximately 273 GB across three members. The projection estimate becomes 1 × 1.3 × 3 = 3.9 GB across three members. Combined planning storage is about 276.9 GB, excluding oplog, backups, filesystem reserve, compression differences, and growth headroom. This is only an estimate: the exact index and BSON overhead must be measured from representative documents and indexes.

## 5. MongoDB operational design

### Indexes

The service relies on the following indexes:

- events: unique on (tenantId, sourceId, eventId)
- jobs: unique on (tenantId, sourceId, externalJobId)
- events: compound index on (processingStatus, availableAt, claimedAt)
- jobs: compound index on (tenantId, sourceId, currentStatus, updatedAt)

This keeps the claim path and list path bounded but adds write overhead on every accepted event and projection update.

### TTL and retention

The current implementation does not configure a TTL index. If seven-day raw-event retention is mandatory, add and verify a TTL policy on a dedicated expiry field only after confirming audit/replay requirements. TTL should affect eligible raw event records, never current job projections. TTL deletion is asynchronous, so retention means an approximate minimum age rather than exact deletion at seven days.

### Hot keys and write contention

The hot keys are the tenant and job identity paths. A noisy tenant can create contention on the same logical key series. The mitigations are to keep worker fan-out bounded, prefer tenant-scoped key isolation, and monitor queue age and retry storms per tenant.

### Partitioning and sharding

For a multi-tenant deployment, a shard key beginning with tenantId can keep tenant-scoped queries targeted, but a single very large tenant may become a hot or jumbo shard. Hashed tenant keys distribute tenants but do not split one tenant's traffic. MongoDB unique indexes on sharded collections must include the shard key as a prefix; the current unique identities `(tenantId, sourceId, eventId)` and `(tenantId, sourceId, externalJobId)` are compatible with a tenant-prefixed shard key. Sharding introduces operational complexity and should follow evidence that a replica set cannot meet throughput or storage needs.

### Uniqueness constraints and trade-offs

The unique constraints are required to prevent duplicate logical events and duplicate job projections within the same tenant/source scope. The trade-off is that concurrent producers legitimately race on the same identity. The service must therefore treat DuplicateKeyError as a normal concurrency condition and re-read the current projection before deciding whether the incoming version is stale or should be retried.

## 6. Backpressure, fairness, and resilience

The current service defaults to two workers, three total attempts, and linear retry delay of `RETRY_BACKOFF_MS × attemptCount` (default delay 1,000 ms). It does not implement admission control, per-tenant fairness, retry jitter, or per-tenant retry quotas; those are scale requirements to add before operating at the modeled rates. Recommended controls are:

- reject or defer new accepts when queue depth or claim lag exceeds a threshold
- cap per-tenant throughput so one noisy tenant does not monopolize the workers
- apply bounded retry backoff with per-tenant retry quotas
- keep MongoDB connections and worker pools bounded so a failure does not become a resource exhaustion event

Noisy-tenant fairness matters because the system is feed-driven: if a single tenant blows up with repeated provider failures, queue age increases for every other tenant. A consistent fairness policy is therefore part of the operational design, not a future optimization.

## 7. Observability and alerts

Operational monitoring should include:

- queue depth by tenant and status
- claim lag and processing lag
- p50/p95 latency for API requests and queue drain time
- retry count and retry-exhausted events
- MongoDB CPU, memory, lock waits, and connection count
- worker utilization and stale-claim recovery rate

Alerts should trigger when queue age grows, provider retries rise, or stale claim recovery exceeds a threshold. Those are the early signs that the queue is no longer sizing correctly under the current tenant mix.

## 8. When a separate broker is justified

A separate broker is justified when the queue is no longer a good fit for MongoDB polling and claim semantics. That usually means one or more of these conditions are true:

- sustained ingestion exceeds the planned 5,000 events/s envelope
- fairness guarantees are violated under heavy tenant skew
- queue-depth spikes or retries make MongoDB claim scans too expensive
- the architecture needs stronger external backpressure and multi-stage buffering

Until those conditions appear, the MongoDB-first design remains appropriate because it keeps the durable queue, projection updates, and idempotency rules in one coherent system.