/**
 * companyNewsQueue.ts — BullMQ Queue for company news collection jobs.
 *
 * Isolated queue — does NOT interfere with any existing queues.
 * Queue name: "company-news-jobs"
 */
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.ts";

// ── Job Payload ───────────────────────────────────────────────────────────────

export interface CompanyNewsJobPayload {
  /** Unique job run identifier */
  jobRunId: string;
  /** News collection sources */
  sources?: string[];
  /** Restrict to specific startup company IDs (empty = all) */
  companyIds?: string[];
  /** How many days back to look for news */
  lookbackDays?: number;
}

export const COMPANY_NEWS_QUEUE_NAME = "company-news-jobs";

/**
 * BullMQ queue for company news collection and classification.
 * 3 attempts with exponential backoff starting at 30 s.
 */
export const companyNewsQueue = new Queue<CompanyNewsJobPayload, any, string>(
  COMPANY_NEWS_QUEUE_NAME,
  {
    connection: createRedisConnection() as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 30_000,
      },
      removeOnComplete: { count: 100, age: 7 * 24 * 3600 },
      removeOnFail: { count: 300, age: 30 * 24 * 3600 },
    },
  }
);

companyNewsQueue.on("error", (err: Error) => {
  console.error(`[CompanyNewsQueue] Queue error: ${err.message}`);
});

/** Adds a news collection job to the queue. Returns the BullMQ Job ID. */
export async function enqueueCompanyNewsJob(
  payload: CompanyNewsJobPayload,
  opts?: { priority?: number; delay?: number }
): Promise<string> {
  const job = await companyNewsQueue.add(
    `news:${payload.jobRunId}`,
    payload,
    {
      priority: opts?.priority ?? 0,
      delay: opts?.delay ?? 0,
    }
  );
  console.log(`[CompanyNewsQueue] Job enqueued → jobId=${job.id} runId=${payload.jobRunId}`);
  return job.id ?? "";
}
