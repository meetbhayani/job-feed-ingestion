import { config } from './config.js';
import { processClaimedEvent } from './service.js';

export function startWorkers(): () => void {
  const stopFns: Array<() => void> = [];
  const workerIds = Array.from({ length: config.workerCount }, (_, index) => `worker-${index + 1}`);

  for (const workerId of workerIds) {
    let keepRunning = true;
    stopFns.push(() => {
      keepRunning = false;
    });

    void (async () => {
      while (keepRunning) {
        const claimed = await processClaimedEvent(workerId);
        if (!claimed) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    })();
  }

  return () => {
    for (const stop of stopFns) {
      stop();
    }
  };
}
