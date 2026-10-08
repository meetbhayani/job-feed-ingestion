import { ObjectId } from 'mongodb';
import { config } from './config.js';
import { getDb } from './db.js';
import { getProviderOutcome } from './provider.js';
import { canonicalizeJson, parseAndValidateEvent } from './validation.js';
import type { EventRecord, JobRecord, NormalizedEvent, ProcessingStatus } from './types.js';

export interface EventAcceptanceResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export async function acceptEvent(input: unknown): Promise<EventAcceptanceResult> {
  const parsed = parseAndValidateEvent(input);
  if (!parsed.ok) {
    return {
      httpStatus: 400,
      body: { error: parsed.error },
    };
  }

  const db = await getDb();
  const events = db.collection<EventRecord>('events');
  const eventDoc = {
    tenantId: parsed.event.tenantId,
    sourceId: parsed.event.sourceId,
    eventId: parsed.event.eventId,
    externalJobId: parsed.event.externalJobId,
    version: parsed.event.version,
    operation: parsed.event.operation,
    payload: parsed.event.payload,
    payloadHash: parsed.canonical,
    processingStatus: 'pending' as ProcessingStatus,
    availableAt: new Date(),
    claimedAt: null,
    claimedBy: null,
    attemptCount: 0,
    attemptHistory: [],
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  };

  try {
    await events.insertOne(eventDoc);
    return {
      httpStatus: 202,
      body: {
        accepted: true,
        replay: false,
        event: { tenantId: parsed.event.tenantId, sourceId: parsed.event.sourceId, eventId: parsed.event.eventId },
        status: 'accepted',
      },
    };
  } catch (error: unknown) {
    const mongoError = error as { code?: number };
    if (mongoError.code === 11000) {
      const existing = await findEventByIdentity(parsed.event.tenantId, parsed.event.sourceId, parsed.event.eventId);
      if (!existing) {
        throw error;
      }
      const isExactReplay = existing.payloadHash === parsed.canonical;
      return {
        httpStatus: isExactReplay ? 200 : 409,
        body: isExactReplay
          ? {
              accepted: false,
              replay: true,
              event: {
                tenantId: existing.tenantId,
                sourceId: existing.sourceId,
                eventId: existing.eventId,
                processingStatus: existing.processingStatus,
                attemptCount: existing.attemptCount,
                lastError: existing.lastError,
              },
            }
          : {
              accepted: false,
              replay: false,
              conflict: true,
              message: 'event identity is already reserved with different content',
            },
      };
    }
    throw error;
  }
}

export async function findEventByIdentity(tenantId: string, sourceId: string, eventId: string): Promise<EventRecord | null> {
  const db = await getDb();
  return (await db.collection<EventRecord>('events').findOne({ tenantId, sourceId, eventId })) as EventRecord | null;
}

export async function getEventDetail(tenantId: string, sourceId: string, eventId: string): Promise<EventRecord | null> {
  return findEventByIdentity(tenantId, sourceId, eventId);
}

export async function getJobByIdentity(tenantId: string, sourceId: string, externalJobId: string): Promise<JobRecord | null> {
  const db = await getDb();
  return (await db.collection<JobRecord>('jobs').findOne({ tenantId, sourceId, externalJobId })) as JobRecord | null;
}

export async function listJobs(args: {
  tenantId: string;
  sourceId?: string;
  status?: 'active' | 'archived' | 'all';
  limit?: number;
  cursor?: string;
}): Promise<{ items: JobRecord[]; nextCursor: string | null; hasMore: boolean }> {
  const db = await getDb();
  const jobs = db.collection<JobRecord>('jobs');
  const sourceFilter = args.sourceId ? { sourceId: args.sourceId } : {};
  const statusFilter = args.status === 'all' ? {} : { currentStatus: args.status ?? 'active' };
  const filter = { tenantId: args.tenantId, ...sourceFilter, ...statusFilter };

  const parsedLimit = Number(args.limit ?? 20);
  const limit = Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 20, 100);

  const cursorPayload = args.cursor ? decodeCursor(args.cursor) : null;
  const cursorFilter = cursorPayload
    ? {
        $or: [
          { updatedAt: { $lt: new Date(cursorPayload.updatedAt) } },
          { updatedAt: new Date(cursorPayload.updatedAt), _id: { $lt: new ObjectId(cursorPayload.id) } },
        ],
      }
    : {};

  const query = { ...filter, ...cursorFilter };
  const rows = await jobs.find(query).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).toArray();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit) as JobRecord[];
  const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null;

  return { items, nextCursor, hasMore };
}

export async function claimNextEvent(workerId: string): Promise<EventRecord | null> {
  const db = await getDb();
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - config.claimTimeoutMs);

  const result = await db.collection<EventRecord>('events').findOneAndUpdate(
    {
      $or: [
        { processingStatus: 'pending', availableAt: { $lte: now } },
        { processingStatus: 'processing', claimedAt: { $lt: staleThreshold } },
      ],
    },
    {
      $set: {
        processingStatus: 'processing',
        claimedAt: now,
        claimedBy: workerId,
        updatedAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    { returnDocument: 'after', sort: { availableAt: 1, createdAt: 1 } },
  );

  if (!result) {
    return null;
  }

  return result as EventRecord;
}

export async function processClaimedEvent(workerId: string): Promise<boolean> {
  const event = await claimNextEvent(workerId);
  if (!event) {
    return false;
  }

  try {
    const job = await getJobByIdentity(event.tenantId, event.sourceId, event.externalJobId);
    const currentVersion = job?.currentVersion ?? 0;

    if (event.version <= currentVersion) {
      await finalizeEvent(event, 'stale-noop', null, 'completed', null);
      return true;
    }

    const providerOutcome = await getProviderOutcome({
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      eventId: event.eventId,
      externalJobId: event.externalJobId,
      version: event.version,
      operation: event.operation,
      payload: event.payload,
    }, event.attemptCount);

    if (providerOutcome.status === 'retry') {
      await handleRetry(event, providerOutcome);
      return true;
    }

    if (providerOutcome.status === 'permanent-failure') {
      await finalizeEvent(event, 'provider-rejected', providerOutcome.reason, 'failed', providerOutcome.code);
      return true;
    }

    await applyJobProjection(event);
    await finalizeEvent(event, 'success', null, 'completed', null);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown processing error';
    await finalizeEvent(event, 'processing-error', message, 'failed', 500);
    return true;
  }
}

async function applyJobProjection(event: EventRecord): Promise<void> {
  const db = await getDb();
  const jobData = event.payload
    ? {
        title: event.payload.title,
        company: event.payload.company,
        location: event.payload.location,
        experienceMin: event.payload.experienceMin,
        experienceMax: event.payload.experienceMax,
        applyUrl: event.payload.applyUrl,
        skills: event.payload.skills,
      }
    : {
        title: null,
        company: null,
        location: null,
        experienceMin: null,
        experienceMax: null,
        applyUrl: null,
        skills: null,
      };

  const now = new Date();
  const base = {
    tenantId: event.tenantId,
    sourceId: event.sourceId,
    externalJobId: event.externalJobId,
    currentVersion: event.version,
    currentStatus: (event.operation === 'archive' ? 'archived' : 'active') as JobRecord['currentStatus'],
    ...jobData,
    updatedAt: now,
    ...(event.operation === 'archive' ? { archivedAt: now } : { archivedAt: null }),
  };

  await db.collection<JobRecord>('jobs').updateOne(
    {
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      externalJobId: event.externalJobId,
      $or: [{ currentVersion: { $exists: false } }, { currentVersion: { $lt: event.version } }],
    },
    {
      $set: base,
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

async function handleRetry(event: EventRecord, providerOutcome: { status: string; code: number; reason: string }): Promise<void> {
  const db = await getDb();
  const attemptCount = event.attemptCount;

  if (attemptCount >= config.maxAttempts) {
    await finalizeEvent(event, 'retry-exhausted', providerOutcome.reason, 'failed', providerOutcome.code);
    return;
  }

  const backoffMs = config.retryBackoffMs * attemptCount;
  const nextAvailableAt = new Date(Date.now() + backoffMs);
  await db.collection<EventRecord>('events').updateOne(
    { _id: event._id },
    {
      $set: {
        processingStatus: 'pending',
        availableAt: nextAvailableAt,
        claimedAt: null,
        claimedBy: null,
        lastError: providerOutcome.reason,
        updatedAt: new Date(),
      },
      $push: {
        attemptHistory: {
          attempt: attemptCount,
          startedAt: event.claimedAt ?? new Date(),
          finishedAt: new Date(),
          outcome: 'retry',
          statusCode: providerOutcome.code,
          message: providerOutcome.reason,
        },
      },
    },
  );
}

async function finalizeEvent(
  event: EventRecord,
  outcome: string,
  message: string | null,
  status: ProcessingStatus,
  statusCode: number | null,
): Promise<void> {
  const db = await getDb();
  const now = new Date();

  await db.collection<EventRecord>('events').updateOne(
    { _id: event._id },
    {
      $set: {
        processingStatus: status,
        claimedAt: null,
        claimedBy: null,
        lastError: message,
        updatedAt: now,
        completedAt: status === 'completed' ? now : null,
      },
      $push: {
        attemptHistory: {
          attempt: event.attemptCount,
          startedAt: event.claimedAt ?? new Date(),
          finishedAt: now,
          outcome,
          statusCode: statusCode ?? undefined,
          message: message ?? undefined,
        },
      },
    },
  );
}

function encodeCursor(job: JobRecord): string {
  const payload = { updatedAt: job.updatedAt.toISOString(), id: String(job._id) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  return JSON.parse(text) as { updatedAt: string; id: string };
}

export function canonicalJsonForEvent(event: NormalizedEvent): string {
  return canonicalizeJson(event);
}
