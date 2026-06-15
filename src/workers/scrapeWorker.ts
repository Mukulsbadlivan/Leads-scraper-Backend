/**
 * scrapeWorker.ts — BullMQ Worker for the "scrape-jobs" queue.
 *
 * Exports startScrapeWorker() so it can be called by workerManager.ts
 * when the backend server boots (in-process worker mode).
 *
 * This module:
 *   - Creates the BullMQ Worker for SCRAPE_QUEUE_NAME
 *   - Wires all event listeners (completed, failed, stalled, error, active)
 *   - Returns the Worker instance for graceful shutdown by the caller
 *
 * DOES NOT:
 *   - Connect to MongoDB or Redis (done by server.ts before this is called)
 *   - Register SIGTERM/SIGINT handlers (owned by server.ts)
 *   - Have a standalone entry point (use npm run worker:dev for isolated local use)
 */
import { Worker, Job } from "bullmq";
import { ObjectId } from "mongodb";
import { createRedisConnection } from "../queue/redis.ts";
import { SCRAPE_QUEUE_NAME, ScrapeJobPayload } from "../queue/scrapeQueue.ts";
import { sendToDeadLetterQueue } from "../queue/failedQueue.ts";
import { runOrchestrator } from "../Orchastrater.ts";
import {
  markRunning,
  updateScrapeRunProgress,
  failScrapeRun,
} from "../database/repositories/ScrapeRunRepository.ts";
import { logger } from "../logging/logger.ts";
import { startDedupWorker } from "./dedupWorker.ts";
import { enqueueDedupJob } from "../queue/dedupQueue.ts";
import { v4 as uuidv4 } from "uuid";
import { enqueueStartupJob } from "../queue/startupQueue.ts";
import { enqueueCompanyNewsJob } from "../queue/companyNewsQueue.ts";
import { performance } from "perf_hooks";

// ─── Worker Configuration ───────────────────────────────────────────────────

// WORKER_CONCURRENCY intentionally defaults to 1 for Render Free Tier stability.
// - Each scrape job launches 1 Playwright browser + up to BROWSER_POOL_SIZE contexts.
// - Multiple concurrent jobs on free tier (512MB RAM) causes OOM crashes.
// - Parallelism inside each job is handled by ENRICHMENT_CONCURRENCY (p-limit).
// - Increase ONLY on Render Standard (2GB+) or self-hosted with sufficient RAM.
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "1", 10);

// Log concurrency configuration at startup for observability
console.log(`[ScrapeWorker] Concurrency config: WORKER_CONCURRENCY=${WORKER_CONCURRENCY} | ENRICHMENT_CONCURRENCY=${process.env.ENRICHMENT_CONCURRENCY || "3"} | BROWSER_POOL_SIZE=${process.env.BROWSER_POOL_SIZE || "2"}`);

// ─── Job Processor ────────────────────────────────────────────────────────────

async function processScrapeJob(job: Job<ScrapeJobPayload>): Promise<void> {
  const { scrapeRunId, country, state, city, sector, selectedSources, maxPages, keywords } =
    job.data;

  console.log(`\n[Worker] 🚀 Processing job ${job.id} | runId=${scrapeRunId} attempt=${job.attemptsMade + 1}/${job.opts.attempts ?? 3}`);

  // ── 1. Resolve MongoDB run ID ───────────────────────────────────────────────
  let runObjectId: ObjectId;
  try {
    runObjectId = new ObjectId(scrapeRunId);
  } catch {
    throw new Error(`Invalid scrapeRunId: ${scrapeRunId}`);
  }

  // ── 2. Mark the run as running in MongoDB ───────────────────────────────────
  await markRunning(runObjectId, job.id ?? "", job.attemptsMade + 1);
  await logger.jobStarted(scrapeRunId, job.id ?? "", job.attemptsMade + 1);

  // ── 3. Progress callback — bridges Orchestrator → BullMQ → MongoDB ──────────
  async function onProgress(update: {
    progress: number;
    currentStage: string;
    currentSource?: string;
    jobsFound?: number;
    companiesFound?: number;
    leadsFound?: number;
  }): Promise<void> {
    // Update BullMQ progress (visible in Bull Board and queue metrics)
    await job.updateProgress(update.progress);

    // Update MongoDB for API polling
    await updateScrapeRunProgress(runObjectId, update).catch(() => {});

    // Log milestone events
    await logger.jobProgress(scrapeRunId, update.progress, update.currentStage, {
      queueJobId: job.id ?? "",
      payload: { currentSource: update.currentSource, jobsFound: update.jobsFound },
    });
  }

  // ── 4. Run the orchestrator ─────────────────────────────────────────────────
  const result = await runOrchestrator(
    {
      country,
      state,
      city,
      sector,
      selectedSources,
      maxPages,
      keywords,
      scrapeRunId, // reuse existing MongoDB run document
    },
    onProgress
  );

  // ── 5. Log completion ───────────────────────────────────────────────────────
  await logger.jobCompleted(scrapeRunId, job.id ?? "", {
    totalLeads: result.totalLeads,
    hotLeads: result.hotLeads,
    warmLeads: result.warmLeads,
    coldLeads: result.coldLeads,
    outputFile: result.outputFile,
  });

  console.log(`[Worker] ✅ Job ${job.id} completed → ${result.totalLeads} leads`);
}

// ─── Worker Factory ───────────────────────────────────────────────────────────

/**
 * Creates and starts the BullMQ scrape worker.
 *
 * Called by workerManager.startAllWorkers() during server bootstrap.
 * MongoDB and Redis must already be connected before calling this.
 *
 * The dedup worker is intentionally NOT started here — workerManager
 * starts it separately to avoid duplicate instances.
 *
 * @returns The Worker instance (caller is responsible for .close() on shutdown).
 */
export function startScrapeWorker(): Worker<ScrapeJobPayload> {
  const redisUrl = (process.env.REDIS_URL || "").trim();
  const redisDisplay = redisUrl
    ? redisUrl.replace(/:([^@]+)@/, ":***@") // redact password
    : `${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || "6379"}`;

  const worker = new Worker<ScrapeJobPayload>(
    SCRAPE_QUEUE_NAME,
    processScrapeJob,
    {
      connection: createRedisConnection() as any,
      concurrency: WORKER_CONCURRENCY,
      stalledInterval: 5 * 60 * 1000,
      maxStalledCount: 2,
    }
  );

  // ── Initialization log ───────────────────────────────────────────────────────
  console.log(`[ScrapeWorker] ✅ Initialized successfully`);
  console.log(`[ScrapeWorker]    Queue    : ${SCRAPE_QUEUE_NAME}`);
  console.log(`[ScrapeWorker]    Redis    : ${redisDisplay}`);
  console.log(`[ScrapeWorker]    Concurrency: ${WORKER_CONCURRENCY}`);
  console.log(`[ScrapeWorker]    Waiting for jobs...`);

  // ── Event Listeners ─────────────────────────────────────────────────────────

  worker.on("completed", async (job) => {
    console.log(`[Worker] ✅ Job ${job.id} (runId=${job.data.scrapeRunId}) completed`);

    // 1. Deduplication — triggered after every scrape
    try {
      await enqueueDedupJob();
    } catch (err: any) {
      console.error("[Worker] ⚠️ Failed to enqueue deduplication job:", err.message);
    }

    // 2. Startup Intelligence enrichment — triggered after every scrape
    try {
      await enqueueStartupJob({
        jobRunId: uuidv4(),
        sources: ["existing_companies", "yc", "wellfound", "rss", "crunchbase"],
        maxCompanies: 200,
        enrichExecutives: true,
        enrichNews: true,
      });
      console.log("[Worker] ✅ Startup Intelligence job enqueued after scrape completion");
    } catch (err: any) {
      console.error("[Worker] ⚠️ Failed to enqueue Startup Intelligence job:", err.message);
    }

    // 3. Company News collection — triggered after every scrape
    try {
      await enqueueCompanyNewsJob({
        jobRunId: uuidv4(),
        sources: ["rss", "google_news", "newsapi"],
        lookbackDays: 7,
      });
      console.log("[Worker] ✅ Company News job enqueued after scrape completion");
    } catch (err: any) {
      console.error("[Worker] ⚠️ Failed to enqueue Company News job:", err.message);
    }
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { scrapeRunId } = job.data;
    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 3;
    const isLastAttempt = attemptsMade >= maxAttempts;

    console.error(
      `[Worker] ❌ Job ${job.id} failed (attempt ${attemptsMade}/${maxAttempts}): ${err.message}`
    );

    await logger.jobFailed(scrapeRunId, job.id ?? "", err, attemptsMade);

    if (isLastAttempt) {
      // ── All retries exhausted → Dead Letter Queue ────────────────────────
      console.error(`[Worker] ☠️  All retries exhausted for runId=${scrapeRunId} → DLQ`);
      await logger.deadLetterQueue(scrapeRunId, err.message);

      // Update MongoDB status to failed
      try {
        const runObjectId = new ObjectId(scrapeRunId);
        await failScrapeRun(runObjectId, err.message, err.stack);
      } catch {
        // If we can't even get the ObjectId, the run was probably invalid anyway
      }

      // Send to Dead Letter Queue
      await sendToDeadLetterQueue({
        scrapeRunId,
        originalJobId: job.id ?? "",
        errorMessage: err.message,
        stackTrace: err.stack,
        failedAt: new Date().toISOString(),
        attemptsMade,
        originalPayload: job.data as unknown as Record<string, unknown>,
      }).catch((dlqErr) => {
        console.error("[Worker] ⚠️  Failed to send to DLQ:", dlqErr.message);
      });
    } else {
      // ── Retry scheduled ─────────────────────────────────────────────────
      const delay = Math.pow(2, attemptsMade - 1) * 60_000; // 1m → 2m → 4m
      await logger.retryAttempt(scrapeRunId, job.id ?? "", attemptsMade + 1, delay);
      console.log(`[Worker] 🔄 Retry ${attemptsMade + 1}/${maxAttempts} scheduled in ${delay / 1000}s`);
    }
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[ScrapeWorker] ⚠️  Job ${jobId} stalled — will be retried automatically`);
  });

  worker.on("error", (err) => {
    console.error(`[ScrapeWorker] ❌ Worker-level error (not a job failure): ${err.message}`);
    console.error(`[ScrapeWorker]    This may indicate a Redis connection problem.`);
  });

  worker.on("active", (job) => {
    console.log(`[ScrapeWorker] 🏃 Job PICKED UP — jobId=${job.id} runId=${job.data.scrapeRunId} attempt=${job.attemptsMade + 1}`);
  });

  worker.on("ready", () => {
    console.log(`[ScrapeWorker] 🟢 Worker is ready, connected to Redis, and polling for jobs`);
  });

  // Verify underlying Redis connection details
  worker.client.then((client) => {
    const stream = (client as any).stream;
    const remoteAddr = stream ? `${stream.remoteAddress}:${stream.remotePort}` : "unknown";
    const status = (client as any).status || "unknown";
    console.log(`[ScrapeWorker] 🔌 Redis Client Status: ${status} | Connected to: ${remoteAddr}`);
  }).catch((err) => {
    console.error(`[ScrapeWorker] ❌ Redis Client Connection verification failed:`, err.message);
  });

  return worker;
}

// ─── Legacy re-export for startDedupWorker ────────────────────────────────────
// Keep this so any existing imports from scrapeWorker still resolve.
export { startDedupWorker };
