import type { EventOperation, NormalizedEvent, UpsertPayload } from './types.js';

export type ValidationResult =
  | { ok: true; event: NormalizedEvent; canonical: string }
  | { ok: false; error: string };

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return output;
  }

  return value;
}

export function parseAndValidateEvent(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const record = input as Record<string, unknown>;

  for (const field of ['tenantId', 'sourceId', 'eventId', 'externalJobId'] as const) {
    if (!isIdentifier(record[field])) {
      return { ok: false, error: `${field} must be a nonblank string without surrounding whitespace.` };
    }
  }

  const tenantId = String(record.tenantId);
  const sourceId = String(record.sourceId);
  const eventId = String(record.eventId);
  const externalJobId = String(record.externalJobId);

  if (!Number.isSafeInteger(record.version) || Number(record.version) <= 0) {
    return { ok: false, error: 'version must be a positive safe integer.' };
  }
  const version = Number(record.version);

  if (record.operation !== 'upsert' && record.operation !== 'archive') {
    return { ok: false, error: 'operation must be either "upsert" or "archive".' };
  }
  const operation = record.operation as EventOperation;

  if (operation === 'archive') {
    if ('payload' in record && record.payload !== undefined) {
      return { ok: false, error: 'archive events must not include a payload.' };
    }
    return {
      ok: true,
      event: {
        tenantId,
        sourceId,
        eventId,
        externalJobId,
        version,
        operation,
      },
      canonical: canonicalizeJson({
        tenantId,
        sourceId,
        eventId,
        externalJobId,
        version,
        operation,
      }),
    };
  }

  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    return { ok: false, error: 'payload is required for upsert events.' };
  }

  const payload = record.payload as Record<string, unknown>;

  const title = getNonBlankString(payload.title, 'title');
  if (!title.ok) {
    return { ok: false, error: title.error };
  }

  const company = getNonBlankString(payload.company, 'company');
  if (!company.ok) {
    return { ok: false, error: company.error };
  }

  const location = getNonBlankString(payload.location, 'location');
  if (!location.ok) {
    return { ok: false, error: location.error };
  }

  if (!Number.isInteger(payload.experienceMin) || Number(payload.experienceMin) < 0 || Number(payload.experienceMin) > 50) {
    return { ok: false, error: 'experienceMin must be an integer from 0 to 50.' };
  }

  if (!Number.isInteger(payload.experienceMax) || Number(payload.experienceMax) < 0 || Number(payload.experienceMax) > 50) {
    return { ok: false, error: 'experienceMax must be an integer from 0 to 50.' };
  }

  if (Number(payload.experienceMin) > Number(payload.experienceMax)) {
    return { ok: false, error: 'experienceMin must be less than or equal to experienceMax.' };
  }

  if (typeof payload.applyUrl !== 'string' || !payload.applyUrl.startsWith('https://')) {
    return { ok: false, error: 'applyUrl must use HTTPS.' };
  }

  if (!Array.isArray(payload.skills)) {
    return { ok: false, error: 'skills must be an array.' };
  }

  const skills: string[] = [];
  const seen = new Set<string>();
  for (const item of payload.skills) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'every skill must be a nonblank string.' };
    }
    const trimmed = item.trim();
    if (!trimmed) {
      return { ok: false, error: 'every skill must be a nonblank string.' };
    }
    const normalizedSkill = trimmed.toLowerCase();
    if (!seen.has(normalizedSkill)) {
      seen.add(normalizedSkill);
      skills.push(normalizedSkill);
    }
  }

  const normalizedPayload: UpsertPayload = {
    title: title.value,
    company: company.value,
    location: location.value,
    experienceMin: Number(payload.experienceMin),
    experienceMax: Number(payload.experienceMax),
    applyUrl: payload.applyUrl as string,
    skills,
  };

  const event: NormalizedEvent = {
    tenantId,
    sourceId,
    eventId,
    externalJobId,
    version,
    operation,
    payload: normalizedPayload,
  };

  return {
    ok: true,
    event,
    canonical: canonicalizeJson(event),
  };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function getNonBlankString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a nonblank string.` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `${field} must be nonblank after trimming.` };
  }
  return { ok: true, value: trimmed };
}
