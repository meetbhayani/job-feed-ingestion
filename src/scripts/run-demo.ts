import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../app.js';
import { connectDatabase, closeDatabase, resetCollections } from '../db.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
type ScenarioItem = { phase: number; request: Record<string, unknown> };

async function waitForEvents(port: number, items: ScenarioItem[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(items.map(async ({ request }) => {
      const query = new URLSearchParams({ tenantId: String(request.tenantId), sourceId: String(request.sourceId) });
      const response = await fetch(`http://localhost:${port}/events/${encodeURIComponent(String(request.eventId))}?${query}`);
      if (!response.ok) return 'missing';
      return (await response.json() as { processingStatus: string }).processingStatus;
    }));
    if (states.every((state) => state === 'completed' || state === 'failed')) return;
    await delay(100);
  }
  throw new Error('workers did not settle within 30 seconds');
}

async function main(): Promise<void> {
  await connectDatabase();
  await resetCollections();
  const { app, stopWorkers } = createApp();
  const port = Number(process.env.PORT ?? 3000);
  const scenario = JSON.parse(await readFile(path.resolve(process.cwd(), 'fixtures', 'demo-scenario.json'), 'utf8')) as ScenarioItem[];
  const server = app.listen(port, async () => {
    try {
      for (const phase of [1, 2]) {
        const phaseItems = scenario.filter((item) => item.phase === phase);
        const accepted: ScenarioItem[] = [];
        for (const item of phaseItems) {
          const response = await fetch(`http://localhost:${port}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item.request) });
          console.log(`phase=${phase} status=${response.status} eventId=${item.request.eventId}`);
          if (response.status === 200 || response.status === 202) accepted.push(item);
        }
        await waitForEvents(port, accepted);
      }
      const finalJobs = await fetch(`http://localhost:${port}/jobs?tenantId=tenant-a&status=all&limit=20`);
      console.log('jobs status', finalJobs.status, await finalJobs.text());
    } finally {
      stopWorkers(); server.close(); await closeDatabase();
    }
  });
}

main().catch((error) => { console.error(error); process.exit(1); });