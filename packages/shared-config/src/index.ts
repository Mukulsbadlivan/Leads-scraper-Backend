/**
 * @icp/shared-config
 *
 * Shared configuration constants used across the ICP Lead Intelligence platform.
 * These values are safe to import in any service (API, Worker, Frontend).
 */

// ─── Queue Names ──────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  SCRAPE_JOBS: "scrape-jobs",
  FAILED_SCRAPE_JOBS: "failed-scrape-jobs",
} as const;

// ─── Retry Policy ─────────────────────────────────────────────────────────────

export const RETRY_POLICY = {
  /** Maximum BullMQ job attempts (1 initial + 2 retries = 3 total) */
  MAX_ATTEMPTS: 3,
  /** Base delay in ms for exponential backoff (60s → 120s → 240s) */
  BASE_DELAY_MS: 60_000,
} as const;

// ─── Timeouts ─────────────────────────────────────────────────────────────────

export const TIMEOUTS = {
  /** Per-lead enrichment timeout in ms */
  ENRICHMENT_MS: 75_000,
  /** Worker stalled job detection interval */
  STALLED_INTERVAL_MS: 5 * 60 * 1000,
} as const;

// ─── Ports ────────────────────────────────────────────────────────────────────

export const PORTS = {
  API: 3000,
  FRONTEND: 3001,
  REDIS: 6379,
} as const;

// ─── Status Values ────────────────────────────────────────────────────────────

export const SCRAPE_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
} as const;

// ─── Job Sources ──────────────────────────────────────────────────────────────

export const JOB_SOURCES = [
  { id: "indeed", label: "Indeed" },
  { id: "glassdoor", label: "Glassdoor" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "upwork", label: "Upwork" },
  { id: "reddit", label: "Reddit" },
] as const;
