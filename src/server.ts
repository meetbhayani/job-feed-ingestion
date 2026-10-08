import { config } from './config.js';
import { closeDatabase, connectDatabase } from './db.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  await connectDatabase();
  const { app, stopWorkers } = createApp();

  const server = app.listen(config.port, () => {
    console.log(`job-feed-ingestion listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    stopWorkers();
    server.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
