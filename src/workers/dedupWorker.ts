/**
 * dedupWorker.ts — BullMQ Worker for the background deduplication queue.
 */

import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../queue/redis.js";
import { DEDUP_QUEUE_NAME } from "../queue/dedupQueue.js";
import { runDeduplication } from "../intelligence/backgroundDeduplicator.js";

/**
 * Initializes and starts the background deduplication worker.
 */
export function startDedupWorker(): Worker {
  const worker = new Worker(
    DEDUP_QUEUE_NAME,
    async (job: Job) => {
      console.log(`[DedupWorker] Processing background deduplication job ${job.id}...`);
      const results = await runDeduplication();
      return results;
    },
    {
      connection: createRedisConnection() as any,
      concurrency: 1, // Only run one deduplication job at a time
    }
  );

  worker.on("completed", (job) => {
    const returnValues = job.returnvalue;
    console.log(
      `[DedupWorker] ✅ Job ${job.id} completed. ` +
      `Merged: ${returnValues?.companiesMerged || 0} companies, ${returnValues?.leadsMerged || 0} leads.`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(`[DedupWorker] ❌ Job ${job?.id} failed: ${err.message}`);
  });

  console.log(`  ✓ Queue Ready    →  ${DEDUP_QUEUE_NAME}`);
  return worker;
}
