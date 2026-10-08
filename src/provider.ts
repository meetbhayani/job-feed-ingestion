import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent, ProviderPlan, ProviderResult } from './types.js';

async function loadProviderPlan(): Promise<ProviderPlan> {
  const planPath = path.resolve(process.cwd(), 'fixtures', 'provider-plan.json');
  const raw = await readFile(planPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ProviderPlan>;
  return {
    defaultOutcome: parsed.defaultOutcome ?? 'success',
    rules: parsed.rules ?? [],
  };
}

export async function getProviderOutcome(event: NormalizedEvent, attemptCount: number): Promise<ProviderResult> {
  const plan = await loadProviderPlan();
  const match = plan.rules.find((rule) => {
    if (rule.tenantId && rule.tenantId !== event.tenantId) return false;
    if (rule.sourceId && rule.sourceId !== event.sourceId) return false;
    if (rule.externalJobId && rule.externalJobId !== event.externalJobId) return false;
    if (rule.eventId && rule.eventId !== event.eventId) return false;
    return true;
  });

  const outcome = match?.outcomes?.[attemptCount - 1] ?? match?.outcome ?? plan.defaultOutcome;
  switch (outcome) {
    case '429':
      return { status: 'retry', code: 429, reason: 'provider rate limited' };
    case '503':
      return { status: 'retry', code: 503, reason: 'provider unavailable' };
    case '422':
      return { status: 'permanent-failure', code: 422, reason: 'provider rejected the payload' };
    default:
      return { status: 'success', code: 200, reason: 'provider accepted payload' };
  }
}
