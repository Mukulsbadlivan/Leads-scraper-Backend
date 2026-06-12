/**
 * companyNewsWorker.ts — BullMQ Worker for company news collection jobs.
 *
 * Exports startCompanyNewsWorker() so it can be called by workerManager.ts
 * when the backend server boots (in-process worker mode).
 *
 * This module:
 *   - Creates the BullMQ Worker for COMPANY_NEWS_QUEUE_NAME
 *   - Wires all event listeners (completed, failed, error)
 *   - Returns the Worker instance for graceful shutdown by the caller
 *
 * DOES NOT:
 *   - Connect to MongoDB or Redis (done by server.ts before this is called)
 *   - Register SIGTERM/SIGINT handlers (owned by server.ts)
 *   - Have a standalone entry point
 */
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../../queue/redis.ts";
import { COMPANY_NEWS_QUEUE_NAME, CompanyNewsJobPayload } from "../../queue/companyNewsQueue.ts";
import { runNewsCollection } from "../../services/companyNews/NewsCollector.ts";
import { deduplicateCompanyNews } from "../../services/companyNews/NewsDeduplicator.ts";
import { extractAndSaveEvents } from "../../services/companyNews/NewsEnricher.ts";
import { listCompanyNewsPaginated } from "../../database/repositories/CompanyNewsRepository.ts";

const CONCURRENCY = parseInt(process.env.NEWS_WORKER_CONCURRENCY ?? "2", 10);

// ─── Job Handler ──────────────────────────────────────────────────────────────

async function processCompanyNewsJob(job: Job<CompanyNewsJobPayload>): Promise<void> {
  const { jobRunId, sources, companyIds, lookbackDays } = job.data;

  const updateProgress = async (stage: string, count = 0) => {
    await job.updateProgress({ stage, count });
    console.log(`[NewsWorker][${jobRunId}] ${stage}`);
  };

  await updateProgress("Collection Phase");

  // Phase 1: Collect articles
  const collectionResult = await runNewsCollection({
    sources: sources ?? ["rss", "google_news", "newsapi"],
    companyIds,
    lookbackDays: lookbackDays ?? 7,
    onProgress: (msg, count) => {
      job.updateProgress({ stage: `Collecting: ${msg}`, count }).catch(() => {});
    },
  });

  await updateProgress("Deduplication Phase", collectionResult.articlesInserted);

  // Phase 2: Deduplication sweep
  await deduplicateCompanyNews();

  // Phase 3: Extract and save structured events from unprocessed articles
  await updateProgress("Event Extraction Phase");

  // Get recently inserted articles and extract events
  const recentArticles = await listCompanyNewsPaginated(1, 100, {});
  let eventsCreated = 0;

  for (const article of recentArticles) {
    if (!article._id) continue;
    try {
      const result = await extractAndSaveEvents(article as any);
      eventsCreated += result.eventsCreated;
    } catch (err: any) {
      console.warn(`[NewsWorker] Event extraction failed for article ${article._id}: ${err.message}`);
    }
  }

  await updateProgress("Complete", eventsCreated);

  console.log(
    `[NewsWorker][${jobRunId}] Done. ` +
    `Collected=${collectionResult.articlesCollected} ` +
    `Inserted=${collectionResult.articlesInserted} ` +
    `Duplicates=${collectionResult.duplicatesSkipped} ` +
    `Events=${eventsCreated}`
  );
}

// ─── Worker Factory ───────────────────────────────────────────────────────────

/**
 * Creates and starts the BullMQ company news worker.
 *
 * Called by workerManager.startAllWorkers() during server bootstrap.
 * MongoDB and Redis must already be connected before calling this.
 *
 * @returns The Worker instance (caller is responsible for .close() on shutdown).
 */
export function startCompanyNewsWorker(): Worker<CompanyNewsJobPayload> {
  const worker = new Worker<CompanyNewsJobPayload>(
    COMPANY_NEWS_QUEUE_NAME,
    processCompanyNewsJob,
    {
      connection: createRedisConnection() as any,
      concurrency: CONCURRENCY,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[NewsWorker] ✅ Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[NewsWorker] ❌ Job ${job?.id} failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error(`[NewsWorker] Worker error: ${err.message}`);
  });

  return worker;
}
