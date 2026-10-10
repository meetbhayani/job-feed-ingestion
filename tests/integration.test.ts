import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closeDatabase, connectDatabase, resetCollections } from '../src/db.js';
import { getDb } from '../src/db.js';
import { claimNextEvent, processClaimedEvent } from '../src/service.js';

let app: ReturnType<typeof createApp>['app'];
let stopWorkers: () => void;

async function restartApp(): Promise<void> {
  if (stopWorkers) {
    stopWorkers();
  }
  config.workerCount = 0;
  await resetCollections();
  const created = createApp();
  app = created.app;
  stopWorkers = created.stopWorkers;
}

beforeAll(async () => {
  await connectDatabase();
  await restartApp();
});

afterAll(async () => {
  stopWorkers();
  await closeDatabase();
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('waitFor timeout');
}

describe('ingestion service', () => {
  it('replays exact duplicates and rejects conflicting event identity reuse', async () => {
    await restartApp();

    const first = await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-1',
        externalJobId: 'alpha',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Full Stack Developer',
          company: 'Example Labs',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.test/jobs/alpha',
          skills: [' TypeScript ', 'MongoDB', 'typescript'],
        },
      })
      .expect(202);

    const replay = await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-1',
        externalJobId: 'alpha',
        version: 1,
        operation: 'upsert',
        payload: {
          title: 'Full Stack Developer',
          company: 'Example Labs',
          location: 'Surat',
          experienceMin: 1,
          experienceMax: 3,
          applyUrl: 'https://example.test/jobs/alpha',
          skills: ['typescript', 'mongodb'],
        },
      })
      .expect(200);
    expect(replay.body.replay).toBe(true);

    const conflict = await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-1',
        externalJobId: 'alpha',
        version: 2,
        operation: 'upsert',
        payload: {
          title: 'Different title',
          company: 'Example Labs',
          location: 'Surat',
          experienceMin: 2,
          experienceMax: 4,
          applyUrl: 'https://example.test/jobs/alpha-v2',
          skills: ['python'],
        },
      })
      .expect(409);

    expect(conflict.body.conflict).toBe(true);
    expect(first.body.event.eventId).toBe('event-1');
  });

  it('processes out-of-order versions and archive-before-upsert safely', async () => {
    await restartApp();

    await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-2',
        externalJobId: 'alpha',
        version: 3,
        operation: 'upsert',
        payload: {
          title: 'Version Three',
          company: 'Example Labs',
          location: 'Surat',
          experienceMin: 3,
          experienceMax: 5,
          applyUrl: 'https://example.test/jobs/alpha-v3',
          skills: ['node'],
        },
      })
      .expect(202);

    await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-3',
        externalJobId: 'alpha',
        version: 2,
        operation: 'upsert',
        payload: {
          title: 'Stale version',
          company: 'Example Labs',
          location: 'Surat',
          experienceMin: 2,
          experienceMax: 4,
          applyUrl: 'https://example.test/jobs/alpha-v2',
          skills: ['go'],
        },
      })
      .expect(202);

    await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-4',
        externalJobId: 'archive-me',
        version: 5,
        operation: 'archive',
      })
      .expect(202);

    await supertest(app)
      .post('/events')
      .send({
        tenantId: 'tenant-a',
        sourceId: 'main',
        eventId: 'event-5',
        externalJobId: 'archive-me',
        version: 4,
        operation: 'upsert',
        payload: {
          title: 'Older archive job',
          company: 'Example Labs',
          location: 'Surat',
          experienceMin: 4,
          experienceMax: 6,
          applyUrl: 'https://example.test/jobs/archive-me',
          skills: ['java'],
        },
      })
      .expect(202);

    for (let index = 0; index < 4; index += 1) {
      await processClaimedEvent(`manual-worker-${index}`);
    }

    await waitFor(async () => {
      const response = await supertest(app)
        .get('/jobs')
        .query({ tenantId: 'tenant-a', sourceId: 'main', status: 'all', limit: 10 });
      const jobs = response.body.items as Array<{ currentVersion: number; currentStatus: string; externalJobId: string }>;
      return jobs.some((job) => job.externalJobId === 'alpha' && job.currentVersion === 3 && job.currentStatus === 'active');
    });

    const archiveResponse = await supertest(app)
      .get('/jobs')
      .query({ tenantId: 'tenant-a', sourceId: 'main', status: 'all', limit: 50 });
    const job = archiveResponse.body.items.find((item: { externalJobId: string }) => item.externalJobId === 'archive-me');
    expect(job.currentStatus).toBe('archived');
    expect(job.currentVersion).toBe(5);
  });

  it('recovers work claimed by a stopped worker', async () => {
    await restartApp();
    const originalTimeout = config.claimTimeoutMs;
    config.claimTimeoutMs = 5;
    try {
      await supertest(app).post('/events').send({
        tenantId: 'tenant-recover', sourceId: 'main', eventId: 'event-recover-1', externalJobId: 'recover-job', version: 1, operation: 'upsert',
        payload: { title: 'Recovered Job', company: 'Example Labs', location: 'Surat', experienceMin: 1, experienceMax: 2, applyUrl: 'https://example.test/jobs/recover-job', skills: ['python'] },
      }).expect(202);
      const { claimNextEvent } = await import('../src/service.js');
      const crashedClaim = await claimNextEvent('dead-worker');
      expect(crashedClaim?.processingStatus).toBe('processing');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await processClaimedEvent('recovery-worker')).toBe(true);
      const db = await getDb();
      const event = await db.collection('events').findOne({ eventId: 'event-recover-1' });
      const job = await db.collection('jobs').findOne({ externalJobId: 'recover-job' });
      expect(event?.processingStatus).toBe('completed');
      expect(event?.attemptCount).toBe(2);
      expect(job?.currentVersion).toBe(1);
      expect(await db.collection('jobs').countDocuments({ externalJobId: 'recover-job' })).toBe(1);
    } finally { config.claimTimeoutMs = originalTimeout; }
  });
  it('supports deterministic cursor pagination for jobs listing', async () => {
    await restartApp();

    for (let index = 0; index < 5; index += 1) {
      await supertest(app)
        .post('/events')
        .send({
          tenantId: 'tenant-page',
          sourceId: 'main',
          eventId: `page-event-${index}`,
          externalJobId: `page-job-${index}`,
          version: index + 1,
          operation: 'upsert',
          payload: {
            title: `Page Job ${index}`,
            company: 'Example Labs',
            location: 'Surat',
            experienceMin: 1,
            experienceMax: 2,
            applyUrl: `https://example.test/jobs/page-job-${index}`,
            skills: ['javascript'],
          },
        })
        .expect(202);
    }

    for (let index = 0; index < 5; index += 1) {
      await processClaimedEvent(`page-worker-${index}`);
    }

    const firstPage = await supertest(app)
      .get('/jobs')
      .query({ tenantId: 'tenant-page', sourceId: 'main', status: 'active', limit: 2 });
    expect(firstPage.body.items.length).toBe(2);
    expect(firstPage.body.hasMore).toBe(true);

    const secondPage = await supertest(app)
      .get('/jobs')
      .query({ tenantId: 'tenant-page', sourceId: 'main', status: 'active', limit: 2, cursor: firstPage.body.nextCursor });
    expect(secondPage.body.items.length).toBe(2);
    expect(secondPage.body.nextCursor).not.toBeNull();
  });

  it('rejects malformed pagination cursors and recovers after a projection write before ack', async () => {
    await restartApp();
    const originalTimeout = config.claimTimeoutMs;
    config.claimTimeoutMs = 5;

    try {
      await supertest(app)
        .post('/events')
        .send({
          tenantId: 'tenant-crash',
          sourceId: 'main',
          eventId: 'event-projection-crash',
          externalJobId: 'job-projection-crash',
          version: 1,
          operation: 'upsert',
          payload: {
            title: 'Crash Recovery Job',
            company: 'Example Labs',
            location: 'Surat',
            experienceMin: 1,
            experienceMax: 2,
            applyUrl: 'https://example.test/jobs/crash-recovery',
            skills: ['node'],
          },
        })
        .expect(202);

      const db = await getDb();
      const claimed = await claimNextEvent('dead-worker-crash');
      expect(claimed?.eventId).toBe('event-projection-crash');

      await db.collection('jobs').updateOne(
        {
          tenantId: 'tenant-crash',
          sourceId: 'main',
          externalJobId: 'job-projection-crash',
          $or: [{ currentVersion: { $exists: false } }, { currentVersion: { $lt: 1 } }],
        },
        {
          $set: {
            tenantId: 'tenant-crash',
            sourceId: 'main',
            externalJobId: 'job-projection-crash',
            currentVersion: 1,
            currentStatus: 'active',
            title: 'Crash Recovery Job',
            company: 'Example Labs',
            location: 'Surat',
            experienceMin: 1,
            experienceMax: 2,
            applyUrl: 'https://example.test/jobs/crash-recovery',
            skills: ['node'],
            updatedAt: new Date(),
            archivedAt: null,
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      await db.collection('events').updateOne(
        { eventId: 'event-projection-crash' },
        { $set: { processingStatus: 'processing', claimedAt: new Date(Date.now() - 1000), claimedBy: 'dead-worker-crash', availableAt: new Date(0), updatedAt: new Date() } },
      );

      const recoveryOutcome = await processClaimedEvent('recovery-worker-crash');
      expect(recoveryOutcome).toBe(true);

      const finalEvent = await db.collection('events').findOne({ eventId: 'event-projection-crash' });
      const finalJob = await db.collection('jobs').findOne({ externalJobId: 'job-projection-crash' });
      expect(finalEvent?.processingStatus).toBe('completed');
      expect(finalEvent?.attemptCount).toBe(2);
      expect(finalJob?.currentVersion).toBe(1);
      expect(await db.collection('jobs').countDocuments({ externalJobId: 'job-projection-crash' })).toBe(1);

      const badCursor = await supertest(app)
        .get('/jobs')
        .query({ tenantId: 'tenant-crash', sourceId: 'main', status: 'active', limit: 20, cursor: 'not-valid-base64' });
      expect(badCursor.status).toBe(400);
    } finally {
      config.claimTimeoutMs = originalTimeout;
    }
  });
});
