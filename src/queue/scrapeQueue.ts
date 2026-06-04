/**
 * scrapeQueue.ts — BullMQ Queue definition for scrape jobs.
 *
 * All scrape operations are enqueued here. The worker process consumes
 * jobs from this queue in a separate process (`npm run worker`).
 *
 * Queue name: "scrape-jobs"
 */
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.ts";

// ─── Job Payload Type ─────────────────────────────────────────────────────────

export interface ScrapeJobPayload {
  /** MongoDB ObjectId string of the scrape_run document */
  scrapeRunId: string;
  /** Target country */
  country: string;
  /** Target state / province */
  state?: string;
  /** Target city */
  city?: string;
  /** Target industry sector */
  sector: string;
  /** List of job portal sources to scrape */
  selectedSources: string[];
  /** Optional: filter for remote jobs only */
  remoteOnly?: boolean;
  /** Optional: job type filter (fulltime, parttime, etc.) */
  jobType?: string;
  /** Max pages to scrape per source */
  maxPages?: number;
  /** Keyword overrides instead of sector-based queries */
  keywords?: string[];
}

// ─── Queue Options ────────────────────────────────────────────────────────────

export const SCRAPE_QUEUE_NAME = "scrape-jobs";

/**
 * Creates and exports the BullMQ scrape queue.
 *
 * Default job options applied to every enqueued job:
 *   - attempts: 3  (automatic retry on failure)
 *   - backoff: exponential starting at 60s (1min → 2min → 4min)
 *   - removeOnComplete: keep last 100 completed jobs for history
 *   - removeOnFail: keep last 500 failed jobs for debugging
 */
export const scrapeQueue = new Queue<ScrapeJobPayload, any, string>(SCRAPE_QUEUE_NAME, {
  connection: createRedisConnection() as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 60_000, // 60s base → 1min, 2min, 4min
    },
    removeOnComplete: {
      count: 100,
      age: 7 * 24 * 3600, // keep for 7 days
    },
    removeOnFail: {
      count: 500,
      age: 30 * 24 * 3600, // keep for 30 days
    },
  },
});

scrapeQueue.on("error", (err: Error) => {
  console.error(`[ScrapeQueue] Queue error: ${err.message}`);
});

/**
 * Adds a scrape job to the queue.
 * Returns the BullMQ Job object with its generated ID.
 */
export async function enqueueScrapeJob(
  payload: ScrapeJobPayload,
  opts?: { priority?: number; delay?: number }
): Promise<string> {
  const job = await scrapeQueue.add(
    `scrape:${payload.scrapeRunId}`,
    payload,
    {
      priority: opts?.priority ?? 0,
      delay: opts?.delay ?? 0,
    }
  );
  console.log(
    `[ScrapeQueue] Job enqueued → jobId=${job.id} runId=${payload.scrapeRunId}`
  );
  return job.id ?? "";
}
