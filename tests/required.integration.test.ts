import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDatabase, connectDatabase, getDb, resetCollections } from '../src/db.js';
import { config } from '../src/config.js';
import { processClaimedEvent } from '../src/service.js';

let app: ReturnType<typeof createApp>['app']; let stopWorkers: () => void;
const valid = (overrides: Record<string, unknown> = {}) => ({ tenantId: 'required-tenant', sourceId: 'main', eventId: 'event-1', externalJobId: 'job-1', version: 1, operation: 'upsert', payload: { title: ' Role ', company: ' Acme ', location: ' Surat ', experienceMin: 1, experienceMax: 2, applyUrl: 'https://example.test/job', skills: [' TypeScript ', 'typescript'] }, ...overrides });

beforeAll(async () => { config.workerCount = 0; config.retryBackoffMs = 1; await connectDatabase(); });
beforeEach(async () => { stopWorkers?.(); await resetCollections(); const created = createApp(); app = created.app; stopWorkers = created.stopWorkers; });
afterAll(async () => { stopWorkers(); await closeDatabase(); });

async function drain(max = 20): Promise<void> { for (let i = 0; i < max; i += 1) { if (!await processClaimedEvent(`test-${i}`)) return; } }

describe.sequential('required integration behavior', () => {
  it('allows corrected reuse after a rejected request and exposes scoped event state', async () => {
    await supertest(app).post('/events').send(valid({ payload: { ...valid().payload as object, applyUrl: 'http://invalid.test' } })).expect(400);
    await supertest(app).post('/events').send(valid()).expect(202);
    const response = await supertest(app).get('/events/event-1').query({ tenantId: 'required-tenant', sourceId: 'main' }).expect(200);
    expect(response.body.processingStatus).toBe('pending'); expect(response.body.attemptCount).toBe(0);
  });

  it('isolates equal IDs by tenant and source', async () => {
    await supertest(app).post('/events').send(valid()).expect(202);
    await supertest(app).post('/events').send(valid({ tenantId: 'other-tenant' })).expect(202);
    await supertest(app).post('/events').send(valid({ sourceId: 'other-source' })).expect(202);
    await drain();
    expect((await supertest(app).get('/jobs').query({ tenantId: 'required-tenant', status: 'all' })).body.items).toHaveLength(2);
    expect((await supertest(app).get('/jobs').query({ tenantId: 'other-tenant', status: 'all' })).body.items).toHaveLength(1);
  });

  it('handles concurrent duplicate acceptance with one logical event and job', async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => supertest(app).post('/events').send(valid())));
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(9);
    await Promise.all([processClaimedEvent('a'), processClaimedEvent('b')]);
    const db = await getDb();
    expect(await db.collection('events').countDocuments({ tenantId: 'required-tenant' })).toBe(1);
    expect(await db.collection('jobs').countDocuments({ tenantId: 'required-tenant' })).toBe(1);
  });

  it('retries a provider failure then succeeds using a fixture plan sequence', async () => {
    const planPath = path.resolve(process.cwd(), 'fixtures/provider-plan.json'); const original = await readFile(planPath, 'utf8');
    try {
      await writeFile(planPath, JSON.stringify({ defaultOutcome: 'success', rules: [{ tenantId: 'required-tenant', eventId: 'retry-success', outcomes: ['503', 'success'] }] }));
      await supertest(app).post('/events').send(valid({ eventId: 'retry-success' })).expect(202);
      await processClaimedEvent('retry-1');
      const db = await getDb(); await db.collection('events').updateOne({ eventId: 'retry-success' }, { $set: { availableAt: new Date(0) } });
      await processClaimedEvent('retry-2');
      const event = await db.collection('events').findOne({ eventId: 'retry-success' });
      expect(event?.processingStatus).toBe('completed'); expect(event?.attemptCount).toBe(2); expect(event?.attemptHistory).toHaveLength(2);
    } finally { await writeFile(planPath, original); }
  });

  it('retains permanent and exhausted provider failures without projection', async () => {
    await supertest(app).post('/events').send(valid({ tenantId: 'tenant-422', eventId: 'event-422', externalJobId: 'permanent-422' })).expect(202);
    await processClaimedEvent('permanent');
    const db = await getDb();
    expect((await db.collection('events').findOne({ eventId: 'event-422' }))?.processingStatus).toBe('failed');
    await supertest(app).post('/events').send(valid({ tenantId: 'tenant-429', eventId: 'event-429', externalJobId: 'retry-429' })).expect(202);
    for (let i = 0; i < 3; i += 1) { await processClaimedEvent(`exhaust-${i}`); await db.collection('events').updateOne({ eventId: 'event-429' }, { $set: { availableAt: new Date(0) } }); }
    const exhausted = await db.collection('events').findOne({ eventId: 'event-429' });
    expect(exhausted?.processingStatus).toBe('failed'); expect(exhausted?.attemptCount).toBe(3); expect(await db.collection('jobs').countDocuments({ tenantId: { $in: ['tenant-422', 'tenant-429'] } })).toBe(0);
  });
});