import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { createApp } from '../app.js';
import { closeDatabase, connectDatabase, getDb } from '../db.js';

const distinctCount = readInteger('LOAD_COUNT', 1000);
const replayCount = readInteger('REPLAY_COUNT', 200);
const outOfOrderJobs = readInteger('OUT_OF_ORDER_JOBS', 50);
const concurrency = readInteger('LOAD_CONCURRENCY', 25);
const tenantPrefix = `load-${randomUUID()}`;
const sourceId = 'load-source';

type EventInput = Record<string, unknown>;
type RequestCounts = { accepted: number; replay: number; errors: number };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer; received ${raw ?? fallback}.`);
  }
  return value;
}

function validateConfiguration(): void {
  if (distinctCount < 1000) {
    throw new Error(`LOAD_COUNT must be at least 1000; received ${distinctCount}.`);
  }
  if (replayCount < 200) {
    throw new Error(`REPLAY_COUNT must be at least 200; received ${replayCount}.`);
  }
  if (replayCount > distinctCount) {
    throw new Error(`REPLAY_COUNT (${replayCount}) cannot exceed LOAD_COUNT (${distinctCount}).`);
  }
  if (outOfOrderJobs < 50) {
    throw new Error(`OUT_OF_ORDER_JOBS must be at least 50; received ${outOfOrderJobs}.`);
  }
}

function eventFor(tenantId: string, eventId: string, externalJobId: string, version: number): EventInput {
  return {
    tenantId,
    sourceId,
    eventId,
    externalJobId,
    version,
    operation: 'upsert',
    payload: {
      title: `Engineer ${eventId}`,
      company: 'Load Test Labs',
      location: 'Surat',
      experienceMin: 1,
      experienceMax: 3,
      applyUrl: `https://example.test/jobs/${eventId}`,
      skills: ['typescript', 'mongodb', 'node'],
    },
  };
}

async function postAll(port: number, events: EventInput[], latencies: number[]): Promise<RequestCounts> {
  const counts: RequestCounts = { accepted: 0, replay: 0, errors: 0 };
  for (let offset = 0; offset < events.length; offset += concurrency) {
    await Promise.all(events.slice(offset, offset + concurrency).map(async (event) => {
      const started = performance.now();
      try {
        const response = await fetch(`http://localhost:${port}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        });
        latencies.push(performance.now() - started);
        if (response.status === 202) counts.accepted += 1;
        else if (response.status === 200) counts.replay += 1;
        else counts.errors += 1;
      } catch {
        latencies.push(performance.now() - started);
        counts.errors += 1;
      }
    }));
  }
  return counts;
}

async function waitForDrain(tenantIds: string[], loadStartedAt: number, timeoutMs = 300000): Promise<number> {
  const started = performance.now();
  const db = await getDb();
  while (performance.now() - started < timeoutMs) {
    const remaining = await db.collection('events').countDocuments({
      tenantId: { $in: tenantIds },
      processingStatus: { $in: ['pending', 'processing'] },
    });
    if (remaining === 0) return performance.now() - loadStartedAt;
    await delay(100);
  }
  throw new Error(`Load-test queue did not drain within ${timeoutMs} ms.`);
}

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)] ?? 0;
}

function assertInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  validateConfiguration();

  const standardTenants = [`${tenantPrefix}-tenant-0`, `${tenantPrefix}-tenant-1`];
  const outTenants = [`${tenantPrefix}-out-0`, `${tenantPrefix}-out-1`];
  const tenantIds = [...standardTenants, ...outTenants];
  const protectionTenant = `${tenantPrefix}-scope-probe`;
  const allOwnedTenants = [...tenantIds, protectionTenant];
  const db = await connectDatabase();

  const eventsCollection = db.collection('events');
  const jobsCollection = db.collection('jobs');
  const markerId = `scope-probe-${tenantPrefix}`;
  await eventsCollection.deleteMany({ tenantId: { $in: tenantIds } });
  await jobsCollection.deleteMany({ tenantId: { $in: tenantIds } });

  const probeEvent = {
    tenantId: protectionTenant,
    sourceId,
    eventId: markerId,
    externalJobId: markerId,
    version: 1,
    operation: 'archive',
    payloadHash: markerId,
    processingStatus: 'completed',
    availableAt: new Date(),
    claimedAt: null,
    claimedBy: null,
    attemptCount: 1,
    attemptHistory: [],
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
  };
  const probeJob = {
    tenantId: protectionTenant,
    sourceId,
    externalJobId: markerId,
    currentVersion: 1,
    currentStatus: 'archived',
    title: null,
    company: null,
    location: null,
    experienceMin: null,
    experienceMax: null,
    applyUrl: null,
    skills: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: new Date(),
  };
  const probeEventId = (await eventsCollection.insertOne(probeEvent)).insertedId;
  const probeJobId = (await jobsCollection.insertOne(probeJob)).insertedId;

  const { app, stopWorkers } = createApp();
  const port = Number(process.env.LOAD_PORT ?? 3100);
  const server = app.listen(port);
  try {
    const latencies: number[] = [];
    const standard = Array.from({ length: distinctCount }, (_, index) =>
      eventFor(standardTenants[index % standardTenants.length], `event-${index}`, `job-${index}`, 1));
    const newerVersions: EventInput[] = [];
    const olderVersions: EventInput[] = [];
    for (let index = 0; index < outOfOrderJobs; index += 1) {
      const tenant = outTenants[index % outTenants.length];
      newerVersions.push(eventFor(tenant, `out-${index}-v2`, `out-job-${index}`, 2));
      olderVersions.push(eventFor(tenant, `out-${index}-v1`, `out-job-${index}`, 1));
    }

    const loadStartedAt = performance.now();
    const newerBatch = await postAll(port, [...standard, ...newerVersions], latencies);
    const olderBatch = await postAll(port, olderVersions, latencies);
    const first: RequestCounts = {
      accepted: newerBatch.accepted + olderBatch.accepted,
      replay: newerBatch.replay + olderBatch.replay,
      errors: newerBatch.errors + olderBatch.errors,
    };
    const submittedCount = standard.length + newerVersions.length + olderVersions.length;
    const replays = await postAll(port, standard.slice(0, replayCount), latencies);
    const drainMs = await waitForDrain(tenantIds, loadStartedAt);

    const expectedEventCount = submittedCount;
    const expectedJobs = distinctCount + outOfOrderJobs;
    const runEvents = await eventsCollection.find({ tenantId: { $in: tenantIds } }).toArray();
    const runJobs = await jobsCollection.find({ tenantId: { $in: tenantIds } }).toArray();
    const outJobRows = runJobs.filter((job) => typeof job.externalJobId === 'string' && job.externalJobId.startsWith('out-job-'));
    const outJobsAtVersion2 = outJobRows.filter((job) => job.currentVersion === 2 && job.currentStatus === 'active');
    const probeEventAfter = await eventsCollection.findOne({ _id: probeEventId });
    const probeJobAfter = await jobsCollection.findOne({ _id: probeJobId });

    assertInvariant(submittedCount >= 1000, `Scenario submitted only ${submittedCount} distinct events.`);
    assertInvariant(first.accepted === submittedCount, `Expected ${submittedCount} new accepts; observed ${first.accepted}.`);
    assertInvariant(first.replay === 0, `Initial submission unexpectedly replayed ${first.replay} events.`);
    assertInvariant(replays.accepted === 0 && replays.replay === replayCount, `Expected ${replayCount} exact replays; observed ${replays.replay} replays and ${replays.accepted} accepts.`);
    assertInvariant(first.errors + replays.errors === 0, `Observed ${first.errors + replays.errors} HTTP/network errors.`);
    assertInvariant(outOfOrderJobs >= 50, `Scenario contains only ${outOfOrderJobs} out-of-order jobs.`);
    assertInvariant(runEvents.length === expectedEventCount, `Expected ${expectedEventCount} stored events; found ${runEvents.length}.`);
    assertInvariant(runEvents.every((event) => event.processingStatus === 'completed'), 'One or more accepted load-test events did not complete successfully.');
    assertInvariant(runJobs.length === expectedJobs, `Expected ${expectedJobs} logical jobs; found ${runJobs.length}.`);
    assertInvariant(outJobRows.length === outOfOrderJobs, `Expected ${outOfOrderJobs} out-of-order job projections; found ${outJobRows.length}.`);
    assertInvariant(outJobsAtVersion2.length === outOfOrderJobs, `Only ${outJobsAtVersion2.length} of ${outOfOrderJobs} out-of-order jobs reached active version 2.`);
    assertInvariant(probeEventAfter?.payloadHash === markerId && probeEventAfter.processingStatus === 'completed', 'Scoped load cleanup modified or removed the unrelated event probe.');
    assertInvariant(probeJobAfter?.externalJobId === markerId && probeJobAfter.currentVersion === 1, 'Scoped load cleanup modified or removed the unrelated job probe.');

    console.log(JSON.stringify({
      machine: os.hostname(),
      mongoUri: process.env.MONGODB_URI ?? 'default local MongoDB',
      concurrency,
      distinctAccepted: first.accepted,
      replayCount: replays.replay,
      errorCount: first.errors + replays.errors,
      httpP50Ms: percentile(latencies, 50),
      httpP95Ms: percentile(latencies, 95),
      queueDrainMs: Math.round(drainMs),
      finalStateChecks: {
        expectedJobs,
        actualJobs: runJobs.length,
        expectedEvents: expectedEventCount,
        actualEvents: runEvents.length,
        outOfOrderJobs: outJobRows.length,
        outOfOrderJobsAtVersion2: outJobsAtVersion2.length,
        unrelatedTenantProbePreserved: true,
      },
    }, null, 2));
  } finally {
    stopWorkers();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await eventsCollection.deleteMany({ tenantId: { $in: allOwnedTenants } });
    await jobsCollection.deleteMany({ tenantId: { $in: allOwnedTenants } });
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
