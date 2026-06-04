/**
 * dedupQueue.ts — BullMQ Queue definition for background data deduplication jobs.
 */

import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

export const DEDUP_QUEUE_NAME = "deduplication-jobs";

/**
 * Creates and exports the BullMQ deduplication queue.
 */
export const dedupQueue = new Queue<any, any, string>(DEDUP_QUEUE_NAME, {
  connection: createRedisConnection() as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 30_000, // 30s base
    },
    removeOnComplete: {
      count: 50,
      age: 2 * 24 * 3600, // keep for 2 days
    },
    removeOnFail: {
      count: 200,
      age: 10 * 24 * 3600, // keep for 10 days
    },
  },
});

dedupQueue.on("error", (err: Error) => {
  console.error(`[DedupQueue] Queue error: ${err.message}`);
});

/**
 * Enqueues a deduplication execution job.
 */
export async function enqueueDedupJob(): Promise<string> {
  const job = await dedupQueue.add("deduplicate", {});
  console.log(`[DedupQueue] Background deduplication job enqueued → jobId=${job.id}`);
  return job.id ?? "";
}
