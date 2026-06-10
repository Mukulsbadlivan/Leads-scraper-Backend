/**
 * companyNewsWorker.ts — Standalone BullMQ Worker for company news collection jobs.
 *
 * Runs as a completely independent process (separate Render service).
 * Manages its own MongoDB and Redis connections.
 * NEVER touches existing scrapeWorker, dedupWorker, or their queues.
 *
 * Startup: node --loader tsx/esm src/workers/companyNews/companyNewsWorker.ts
 */
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../../queue/redis.ts";
import { COMPANY_NEWS_QUEUE_NAME, CompanyNewsJobPayload } from "../../queue/companyNewsQueue.ts";
import { getDb } from "../../database/connection.ts";
import { initStartupDb } from "../../database/initStartupDb.ts";
import { runNewsCollection } from "../../services/companyNews/NewsCollector.ts";
import { deduplicateCompanyNews } from "../../services/companyNews/NewsDeduplicator.ts";
import { extractAndSaveEvents } from "../../services/companyNews/NewsEnricher.ts";
import { listCompanyNewsPaginated } from "../../database/repositories/CompanyNewsRepository.ts";
import { ObjectId } from "mongodb";

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

// ─── Worker Lifecycle ──────────────────────────────────────────────────────────

async function main() {
  console.log(`🚀 Company News Worker starting (concurrency=${CONCURRENCY})`);

  // Initialize DB and indexes
  await getDb();
  await initStartupDb();

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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[NewsWorker] ${signal} received — closing worker...`);
    await worker.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`✅ Company News Worker ready — listening on queue: ${COMPANY_NEWS_QUEUE_NAME}`);
}

main().catch((err) => {
  console.error("[NewsWorker] Fatal startup error:", err);
  process.exit(1);
});
