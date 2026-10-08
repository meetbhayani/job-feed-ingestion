import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/job_feed_ingestion',
  workerCount: Number(process.env.WORKER_COUNT ?? 2),
  claimTimeoutMs: Number(process.env.CLAIM_TIMEOUT_MS ?? 5000),
  retryBackoffMs: Number(process.env.RETRY_BACKOFF_MS ?? 1000),
  maxAttempts: 3,
};
