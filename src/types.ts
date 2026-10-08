export type EventOperation = 'upsert' | 'archive';
export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type JobStatus = 'active' | 'archived';

export interface UpsertPayload {
  title: string;
  company: string;
  location: string;
  experienceMin: number;
  experienceMax: number;
  applyUrl: string;
  skills: string[];
}

export interface NormalizedEvent {
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: EventOperation;
  payload?: UpsertPayload;
}

export interface EventRecord {
  _id?: import('mongodb').ObjectId;
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  version: number;
  operation: EventOperation;
  payload?: UpsertPayload;
  payloadHash: string;
  processingStatus: ProcessingStatus;
  availableAt: Date;
  claimedAt?: Date | null;
  claimedBy?: string | null;
  attemptCount: number;
  attemptHistory: Array<{
    attempt: number;
    startedAt: Date;
    finishedAt: Date;
    outcome: string;
    statusCode?: number;
    message?: string;
  }>;
  lastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
}

export interface JobRecord {
  _id?: import('mongodb').ObjectId;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  currentVersion: number;
  currentStatus: JobStatus;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  experienceMin?: number | null;
  experienceMax?: number | null;
  applyUrl?: string | null;
  skills?: string[] | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date | null;
}

export interface ProviderResult {
  status: 'success' | 'retry' | 'permanent-failure';
  code: number;
  reason: string;
}

export interface ProviderRule {
  tenantId?: string;
  sourceId?: string;
  externalJobId?: string;
  eventId?: string;
  outcome?: 'success' | '429' | '503' | '422';
  outcomes?: Array<'success' | '429' | '503' | '422'>;
}

export interface ProviderPlan {
  defaultOutcome: 'success' | '429' | '503' | '422';
  rules: ProviderRule[];
}
