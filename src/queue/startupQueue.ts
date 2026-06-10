/**
 * startupQueue.ts — BullMQ Queue for startup intelligence jobs.
 *
 * Isolated queue — does NOT interfere with the existing "scrape-jobs" queue.
 * Queue name: "startup-intelligence-jobs"
 */
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.ts";

// ── Job Payload ───────────────────────────────────────────────────────────────

export interface StartupJobPayload {
  /** Unique job run identifier */
  jobRunId: string;
  /** Discovery sources to use */
  sources?: string[];
  /** Optional sector filter */
  sectors?: string[];
  /** Optional funding stage filter */
  stages?: string[];
  /** Max companies to discover */
  maxCompanies?: number;
  /** Enrich executive profiles */
  enrichExecutives?: boolean;
  /** Also trigger news enrichment */
  enrichNews?: boolean;
}

export const STARTUP_QUEUE_NAME = "startup-intelligence-jobs";

/**
 * BullMQ queue for startup intelligence discovery and enrichment.
 * 3 attempts with exponential backoff starting at 60 s.
 */
export const startupQueue = new Queue<StartupJobPayload, any, string>(
  STARTUP_QUEUE_NAME,
  {
    connection: createRedisConnection() as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 60_000,
      },
      removeOnComplete: { count: 50, age: 7 * 24 * 3600 },
      removeOnFail: { count: 200, age: 30 * 24 * 3600 },
    },
  }
);

startupQueue.on("error", (err: Error) => {
  console.error(`[StartupQueue] Queue error: ${err.message}`);
});

/** Adds a startup intelligence job to the queue. Returns the BullMQ Job ID. */
export async function enqueueStartupJob(
  payload: StartupJobPayload,
  opts?: { priority?: number; delay?: number }
): Promise<string> {
  const job = await startupQueue.add(
    `startup:${payload.jobRunId}`,
    payload,
    {
      priority: opts?.priority ?? 0,
      delay: opts?.delay ?? 0,
    }
  );
  console.log(`[StartupQueue] Job enqueued → jobId=${job.id} runId=${payload.jobRunId}`);
  return job.id ?? "";
}
