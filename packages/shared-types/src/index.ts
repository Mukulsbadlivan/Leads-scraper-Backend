/**
 * @icp/shared-types
 *
 * Shared TypeScript interfaces used by all services in the ICP Lead Intelligence platform.
 * This package is the single source of truth for data contracts.
 *
 * Consumers:
 *   - apps/api      (Express backend)
 *   - apps/worker   (BullMQ worker)
 *   - apps/frontend (Next.js dashboard)
 *
 * Usage (after Turborepo migration):
 *   import { ScrapeRun, ScrapeJobPayload } from "@icp/shared-types";
 */

// ─── Scrape Run ───────────────────────────────────────────────────────────────

export type ScrapeRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "partial";

export interface ScrapeRun {
  _id: string;
  queueJobId?: string;
  status: ScrapeRunStatus;
  progress?: number;
  currentStage?: string;
  currentSource?: string;
  startedAt: string;
  completedAt?: string;
  country?: string;
  state?: string;
  city?: string;
  sector?: string;
  sources?: string[];
  portals?: string[];
  selectedSources?: string[];
  searchQueries?: string[];
  locations?: string[];
  maxPages?: number;
  keywords?: string[];
  jobsFound?: number;
  companiesFound?: number;
  leadsFound?: number;
  retryCount?: number;
  rawLeadsFound?: number;
  uniqueCompanies?: number;
  enrichedLeads?: number;
  filteredLeads?: number;
  hotLeads?: number;
  warmLeads?: number;
  coldLeads?: number;
  errorMessage?: string;
  stackTrace?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Queue Job Payload ────────────────────────────────────────────────────────

export interface ScrapeJobPayload {
  scrapeRunId: string;
  country: string;
  state?: string;
  city?: string;
  sector: string;
  selectedSources: string[];
  remoteOnly?: boolean;
  jobType?: string;
  maxPages?: number;
  keywords?: string[];
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface StartScrapeResponse {
  success: boolean;
  scrapeRunId: string;
  queueJobId: string;
  message: string;
}

export interface ScrapeStatusResponse {
  isRunning: boolean;
  scrapeRunId?: string;
  queueJobId?: string;
  status?: ScrapeRunStatus;
  progress?: number;
  currentStage?: string;
  currentSource?: string;
  jobsFound?: number;
  companiesFound?: number;
  leadsFound?: number;
  retryCount?: number;
  startedAt?: string;
  country?: string;
  state?: string;
  city?: string;
  sector?: string;
  selectedSources?: string[];
  region?: string;
}

export interface QueueMetrics {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export type LogEventType =
  | "QueueCreated"
  | "WorkerStarted"
  | "WorkerStopped"
  | "JobStarted"
  | "JobProgress"
  | "JobCompleted"
  | "JobFailed"
  | "RetryAttempt"
  | "DeadLetterQueue"
  | "ApiRequest"
  | "SystemError";

export type LogLevel = "info" | "warn" | "error" | "debug";
