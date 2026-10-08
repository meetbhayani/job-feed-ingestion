import os from 'node:os';
import { createApp } from '../app.js';
import { closeDatabase, connectDatabase, getDb } from '../db.js';

const distinctCount = Number(process.env.LOAD_COUNT ?? 1000);
const replayCount = Number(process.env.REPLAY_COUNT ?? 200);
const outOfOrderJobs = Number(process.env.OUT_OF_ORDER_JOBS ?? 50);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 25);
const tenantPrefix = `load-${Date.now()}`;

type EventInput = Record<string, unknown>;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function eventFor(tenantId: string, eventId: string, externalJobId: string, version: number): EventInput {
  return { tenantId, sourceId: 'load-source', eventId, externalJobId, version, operation: 'upsert', payload: { title: `Engineer ${eventId}`, company: 'Load Test Labs', location: 'Surat', experienceMin: 1, experienceMax: 3, applyUrl: `https://example.test/jobs/${eventId}`, skills: ['typescript', 'mongodb', 'node'] } };
}

async function postAll(port: number, events: EventInput[], latencies: number[]): Promise<{ accepted: number; replay: number; errors: number }> {
  let accepted = 0; let replay = 0; let errors = 0;
  for (let offset = 0; offset < events.length; offset += concurrency) {
    await Promise.all(events.slice(offset, offset + concurrency).map(async (event) => {
      const started = performance.now();
      const response = await fetch(`http://localhost:${port}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
      latencies.push(performance.now() - started);
      if (response.status === 202) accepted += 1;
      else if (response.status === 200) replay += 1;
      else errors += 1;
    }));
  }
  return { accepted, replay, errors };
}

async function waitForDrain(tenantIds: string[]): Promise<number> {
  const started = performance.now(); const db = await getDb();
  while (true) {
    const remaining = await db.collection('events').countDocuments({ tenantId: { $in: tenantIds }, processingStatus: { $in: ['pending', 'processing'] } });
    if (remaining === 0) return performance.now() - started;
    await delay(100);
  }
}

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)] ?? 0;
}

async function main(): Promise<void> {
  await connectDatabase();
  const { app, stopWorkers } = createApp();
  const port = Number(process.env.LOAD_PORT ?? 3100);
  const server = app.listen(port);
  try {
    const latencies: number[] = [];
    const standard = Array.from({ length: distinctCount }, (_, index) => eventFor(`${tenantPrefix}-tenant-${index % 2}`, `event-${index}`, `job-${index}`, 1));
    const ordered: EventInput[] = [];
    for (let index = 0; index < outOfOrderJobs; index += 1) {
      const tenant = `${tenantPrefix}-out-${index % 2}`;
      ordered.push(eventFor(tenant, `out-${index}-v2`, `out-job-${index}`, 2));
      ordered.push(eventFor(tenant, `out-${index}-v1`, `out-job-${index}`, 1));
    }
    const first = await postAll(port, [...standard, ...ordered], latencies);
    const replays = await postAll(port, standard.slice(0, replayCount), latencies);
    const tenantIds = [`${tenantPrefix}-tenant-0`, `${tenantPrefix}-tenant-1`, `${tenantPrefix}-out-0`, `${tenantPrefix}-out-1`];
    const drainMs = await waitForDrain(tenantIds);
    const db = await getDb();
    const expectedJobs = distinctCount + outOfOrderJobs;
    const actualJobs = await db.collection('jobs').countDocuments({ tenantId: { $in: tenantIds } });
    const staleVersions = await db.collection('jobs').countDocuments({ tenantId: { $in: [`${tenantPrefix}-out-0`, `${tenantPrefix}-out-1`] }, currentVersion: { $ne: 2 } });
    console.log(JSON.stringify({ machine: os.hostname(), mongoUri: process.env.MONGODB_URI ?? 'default local MongoDB', concurrency, distinctAccepted: first.accepted, replayCount: replays.replay, errorCount: first.errors + replays.errors, httpP50Ms: percentile(latencies, 50), httpP95Ms: percentile(latencies, 95), queueDrainMs: Math.round(drainMs), finalStateChecks: { expectedJobs, actualJobs, outOfOrderJobsAtVersion2: outOfOrderJobs - staleVersions } }, null, 2));
  } finally {
    stopWorkers(); server.close(); await closeDatabase();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });