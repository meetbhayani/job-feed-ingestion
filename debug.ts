import { config } from './src/config.js';
import { closeDatabase, connectDatabase } from './src/db.js';
import { acceptEvent, getEventDetail, getJobByIdentity, processClaimedEvent } from './src/service.js';

async function main(): Promise<void> {
  const runId = Date.now().toString();
  const event = {
    tenantId: `debug-tenant-${runId}`,
    sourceId: 'debug',
    eventId: `debug-event-${runId}`,
    externalJobId: `debug-job-${runId}`,
    version: 1,
    operation: 'upsert',
    payload: {
      title: 'Debug Role',
      company: 'Debug Example',
      location: 'Surat',
      experienceMin: 1,
      experienceMax: 2,
      applyUrl: 'https://example.test/debug-job',
      skills: ['typescript'],
    },
  };

  try {
    const db = await connectDatabase();
    const now = new Date();
    const otherClaimableEvent = await db.collection('events').findOne({
      $or: [
        { processingStatus: 'pending', availableAt: { $lte: now } },
        { processingStatus: 'processing', claimedAt: { $lt: new Date(now.getTime() - config.claimTimeoutMs) } },
      ],
    });
    if (otherClaimableEvent) {
      throw new Error('Debug script requires no other claimable events; use an idle or dedicated debug database.');
    }

    const accepted = await acceptEvent(event);
    console.log('accept', { httpStatus: accepted.httpStatus, body: accepted.body });

    const before = await getEventDetail(event.tenantId, event.sourceId, event.eventId);
    console.log('before processing', {
      processingStatus: before?.processingStatus,
      attemptCount: before?.attemptCount,
    });

    const processed = await processClaimedEvent('debug-worker');
    const after = await getEventDetail(event.tenantId, event.sourceId, event.eventId);
    const job = await getJobByIdentity(event.tenantId, event.sourceId, event.externalJobId);

    console.log('process direct', processed);
    console.log('after processing', {
      processingStatus: after?.processingStatus,
      attemptCount: after?.attemptCount,
      lastError: after?.lastError,
    });
    console.log('job projection', job && {
      externalJobId: job.externalJobId,
      currentVersion: job.currentVersion,
      currentStatus: job.currentStatus,
      title: job.title,
      company: job.company,
      location: job.location,
      skills: job.skills,
    });
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  const nodeProcess = (globalThis as typeof globalThis & {
    process?: { exit?: (code?: number) => never };
  }).process;
  nodeProcess?.exit?.(1);
});
