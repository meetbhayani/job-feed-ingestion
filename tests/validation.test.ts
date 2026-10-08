import { describe, expect, it } from 'vitest';
import { parseAndValidateEvent } from '../src/validation.js';

describe('event validation', () => {
  it('accepts a valid upsert event and normalizes skills', () => {
    const result = parseAndValidateEvent({
      tenantId: 'tenant-a',
      sourceId: 'main',
      eventId: 'event-101',
      externalJobId: 'alpha',
      version: 1,
      operation: 'upsert',
      payload: {
        title: ' Full Stack Developer ',
        company: ' Example Labs ',
        location: ' Surat ',
        experienceMin: 1,
        experienceMax: 3,
        applyUrl: 'https://example.test/jobs/alpha',
        skills: [' TypeScript ', 'MongoDB', 'typescript'],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const payload = result.event.payload;
    expect(payload).toBeDefined();
    if (!payload) {
      return;
    }

    expect(payload.title).toBe('Full Stack Developer');
    expect(payload.skills).toEqual(['typescript', 'mongodb']);
  });

  it('rejects identifiers with surrounding whitespace', () => {
    const result = parseAndValidateEvent({
      tenantId: ' tenant-a ',
      sourceId: 'main',
      eventId: 'event-1',
      externalJobId: 'alpha',
      version: 1,
      operation: 'upsert',
      payload: {
        title: 'Role',
        company: 'Acme',
        location: 'Surat',
        experienceMin: 0,
        experienceMax: 1,
        applyUrl: 'https://example.test/job',
        skills: ['aws'],
      },
    });

    expect(result.ok).toBe(false);
  });
});
