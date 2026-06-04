import { ObjectId } from "mongodb";

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Full lifecycle of a scrape run.
 *
 * queued     → Job accepted, waiting in BullMQ queue
 * running    → Worker picked up the job, scraping in progress
 * completed  → All scrapers finished, leads saved
 * failed     → All retry attempts exhausted, moved to DLQ
 * partial    → Some scrapers failed, partial results saved
 */
export type ScrapeRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "partial";

// ─── Document ─────────────────────────────────────────────────────────────────

/**
 * Tracks a single execution of the scraper pipeline.
 * Maps to the `scrape_runs` collection in MongoDB.
 */
export interface ScrapeRunDocument {
  _id?: ObjectId;

  // ── Queue Identity ──────────────────────────────────────────────────────────
  /** BullMQ job ID assigned when enqueued */
  queueJobId?: string;

  // ── Runtime Identity ────────────────────────────────────────────────────────
  status: ScrapeRunStatus;
  startedAt: Date;
  completedAt?: Date;

  // ── Live Progress (updated by worker in real-time) ──────────────────────────
  /** 0–100 percent completion */
  progress?: number;
  /** Current high-level stage: "queued" | "scraping" | "enriching" | "scoring" | "saving" */
  currentStage?: string;
  /** Which source portal is currently being scraped */
  currentSource?: string;
  /** Running count of raw job listings found */
  jobsFound?: number;
  /** Running count of unique companies identified */
  companiesFound?: number;
  /** Running count of enriched + scored leads */
  leadsFound?: number;

  // ── Retry Tracking ──────────────────────────────────────────────────────────
  /** BullMQ attempt number (1 = first try, 2 = first retry, etc.) */
  retryCount?: number;

  // ── Config snapshot (what was requested) ─────────────────────────────────────
  portals?: string[];
  selectedSources?: string[];
  searchQueries?: string[];
  locations?: string[];
  outputFile?: string;
  country?: string;
  state?: string;
  city?: string;
  sector?: string;
  remoteOnly?: boolean;
  jobType?: string;
  maxPages?: number;
  keywords?: string[];

  // ── Final Stats ──────────────────────────────────────────────────────────────
  rawLeadsFound?: number;
  uniqueCompanies?: number;
  enrichedLeads?: number;
  filteredLeads?: number;
  hotLeads?: number;
  warmLeads?: number;
  coldLeads?: number;

  // ── Error capture ────────────────────────────────────────────────────────────
  errorMessage?: string;
  stackTrace?: string;

  // ── Meta ─────────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
