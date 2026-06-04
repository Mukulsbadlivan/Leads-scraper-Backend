/**
 * failedQueue.ts — Dead Letter Queue for permanently failed scrape jobs.
 *
 * When a scrape job exhausts all retry attempts (3x with exponential backoff),
 * the worker's `failed` event handler enqueues the job here for audit and
 * manual re-queue via the admin API.
 *
 * Queue name: "failed-scrape-jobs"
 */
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.ts";

// ─── Failed Job Payload ───────────────────────────────────────────────────────

export interface FailedScrapeJobPayload {
  /** Original scrape run MongoDB ObjectId string */
  scrapeRunId: string;
  /** Original BullMQ job ID that failed */
  originalJobId: string;
  /** Human-readable error message */
  errorMessage: string;
  /** Full stack trace for debugging */
  stackTrace?: string;
  /** ISO timestamp when the final failure occurred */
  failedAt: string;
  /** Number of attempts that were made */
  attemptsMade: number;
  /** Original job payload, preserved for re-queue */
  originalPayload: Record<string, unknown>;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export const FAILED_QUEUE_NAME = "failed-scrape-jobs";

/**
 * Dead Letter Queue — jobs land here after exhausting all retry attempts.
 * Jobs are kept indefinitely (no removeOnComplete/removeOnFail TTL)
 * so ops teams can review and manually retry.
 */
export const failedScrapeQueue = new Queue<FailedScrapeJobPayload, any, string>(
  FAILED_QUEUE_NAME,
  {
    connection: createRedisConnection() as any,
    defaultJobOptions: {
      attempts: 1, // DLQ jobs don't auto-retry
      removeOnComplete: false, // Keep all for audit
      removeOnFail: false,
    },
  }
);

failedScrapeQueue.on("error", (err: Error) => {
  console.error(`[FailedQueue] Queue error: ${err.message}`);
});

/**
 * Moves a permanently failed job into the Dead Letter Queue.
 * Called by the scrapeWorker after all retry attempts are exhausted.
 */
export async function sendToDeadLetterQueue(
  payload: FailedScrapeJobPayload
): Promise<string> {
  const job = await failedScrapeQueue.add(
    `failed:${payload.scrapeRunId}`,
    payload
  );
  console.error(
    `[FailedQueue] Job moved to DLQ → jobId=${job.id} runId=${payload.scrapeRunId} error=${payload.errorMessage}`
  );
  return job.id ?? "";
}
