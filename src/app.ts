import express, { type Express } from 'express';
import { getDb } from './db.js';
import { acceptEvent, getEventDetail, listJobs } from './service.js';
import { startWorkers } from './workers.js';

export function createApp(): { app: Express; stopWorkers: () => void } {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      res.json({ status: 'ready', mongodb: 'ready', meaning: 'MongoDB is reachable and the service is accepting work.' });
    } catch (error) {
      res.status(503).json({ status: 'degraded', mongodb: 'unavailable', meaning: 'MongoDB is not ready.' });
    }
  });

  app.post('/events', async (req, res) => {
    try {
      const result = await acceptEvent(req.body);
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'unknown error' });
    }
  });

  app.get('/events/:eventId', async (req, res) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;

    if (!tenantId || !sourceId) {
      res.status(400).json({ error: 'tenantId and sourceId query params are required.' });
      return;
    }

    const event = await getEventDetail(tenantId, sourceId, req.params.eventId);
    if (!event) {
      res.status(404).json({ error: 'event not found' });
      return;
    }

    res.json({
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      eventId: event.eventId,
      externalJobId: event.externalJobId,
      version: event.version,
      operation: event.operation,
      processingStatus: event.processingStatus,
      attemptCount: event.attemptCount,
      lastError: event.lastError,
      payload: event.payload ?? null,
      attemptHistory: event.attemptHistory,
      availableAt: event.availableAt,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    });
  });

  app.get('/jobs', async (req, res) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    if (!tenantId) {
      res.status(400).json({ error: 'tenantId is required.' });
      return;
    }

    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    const status: 'active' | 'archived' | 'all' =
      req.query.status === 'archived' || req.query.status === 'all' ? req.query.status : 'active';
    const limit = Number(req.query.limit ?? 20);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const page = await listJobs({ tenantId, sourceId, status, limit, cursor });
    res.json(page);
  });

  const stopWorkers = startWorkers();
  return { app, stopWorkers };
}
