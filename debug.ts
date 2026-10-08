import { config } from './src/config.js';
import { connectDatabase, getDb, resetCollections, closeDatabase } from './src/db.js';
import { acceptEvent, processClaimedEvent } from './src/service.js';

async function main(): Promise<void> {
  config.workerCount = 0;
  await connectDatabase();
  await resetCollections();

  const event = {
    tenantId: 'tenant-a',
    sourceId: 'main',
    eventId: 'z',
    externalJobId: 'alpha',
    version: 1,
    operation: 'upsert',
    payload: {
      title: 'Role',
      company: 'Acme',
      location: 'Surat',
      experienceMin: 1,
      experienceMax: 2,
      applyUrl: 'https://example.test/job',
      skills: ['typescript'],
    },
  };

  console.log('accept', await acceptEvent(event));
  const db = await getDb();
  console.log('pending before', await db.collection('events').find({ processingStatus: 'pending' }).toArray());
  const result = await processClaimedEvent('worker-1');
  console.log('process direct', result);
  console.log('after process', await db.collection('events').find({}).toArray());
  await closeDatabase();
}

main().catch((error) => {
  console.error(error);
  const nodeProcess = (globalThis as typeof globalThis & {
    process?: { exit?: (code?: number) => never };
  }).process;
  nodeProcess?.exit?.(1);
});
