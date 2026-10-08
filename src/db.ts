import { Db, MongoClient } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connectDatabase(): Promise<Db> {
  if (db) {
    return db;
  }

  client = new MongoClient(config.mongoUri);
  await client.connect();

  db = client.db();
  await ensureIndexes(db);
  return db;
}

export async function getDb(): Promise<Db> {
  return db ?? connectDatabase();
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
  }
  client = undefined;
  db = undefined;
}

export async function resetCollections(): Promise<void> {
  const currentDb = await getDb();
  await currentDb.collection('events').deleteMany({});
  await currentDb.collection('jobs').deleteMany({});
}

async function ensureIndexes(currentDb: Db): Promise<void> {
  await currentDb.collection('events').createIndexes([
    { key: { tenantId: 1, sourceId: 1, eventId: 1 }, unique: true },
    { key: { processingStatus: 1, availableAt: 1, claimedAt: 1 } },
  ]);

  await currentDb.collection('jobs').createIndexes([
    { key: { tenantId: 1, sourceId: 1, externalJobId: 1 }, unique: true },
    { key: { tenantId: 1, sourceId: 1, currentStatus: 1, updatedAt: -1 } },
  ]);
}
