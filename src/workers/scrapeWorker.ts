/**
 * scrapeWorker.ts — BullMQ Worker for the "scrape-jobs" queue.
 *
 * Run with: npm run worker
 *
 * This process:
 *   1. Connects to Redis and MongoDB
 *   2. Picks up jobs from the "scrape-jobs" queue
 *   3. Calls runOrchestrator() with the job payload
 *   4. Emits progress updates to MongoDB via updateScrapeRunProgress()
 *   5. On all retries exhausted → moves job to "failed-scrape-jobs" DLQ
 *   6. Logs all lifecycle events to MongoDB and console
 */
import "dotenv/config";
import { Worker, Job } from "bullmq";
import { ObjectId } from "mongodb";
import {
  createRedisConnection,
  closeRedisConnection,
  validateRedisConnection,
  resolveRedisConfig,
} from "../queue/redis.ts";
import { SCRAPE_QUEUE_NAME, ScrapeJobPayload } from "../queue/scrapeQueue.ts";
import { sendToDeadLetterQueue } from "../queue/failedQueue.ts";
import { runOrchestrator } from "../Orchastrater.ts";
import { initDb } from "../database/initDb.ts";
import { closeConnection } from "../database/connection.ts";
import {
  markRunning,
  updateScrapeRunProgress,
  failScrapeRun,
} from "../database/repositories/ScrapeRunRepository.ts";
import { logger, ensureLogIndexes } from "../logging/logger.ts";
import { startDedupWorker } from "./dedupWorker.js";
import { enqueueDedupJob } from "../queue/dedupQueue.js";
import { v4 as uuidv4 } from "uuid";
import { enqueueStartupJob } from "../queue/startupQueue.ts";
import { enqueueCompanyNewsJob } from "../queue/companyNewsQueue.ts";

// ─── Worker Configuration ─────────────────────────────────────────────────────

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "1", 10);

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

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const LINE = "─".repeat(50);
  console.log(`\n${LINE}`);
  console.log("  ICP Lead Intelligence — BullMQ Worker");
  console.log(LINE);

  // ── 1. MongoDB ──────────────────────────────────────────────────────────────
  try {
    await initDb();
    await ensureLogIndexes();
    console.log("  ✓ MongoDB Connected");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ MongoDB  — ${message}`);
    console.warn("    Continuing — progress won't be persisted but jobs will run.");
  }

  await logger.workerStarted();

  // ── 2. Redis (FATAL if unreachable) ─────────────────────────────────────────
  const redisCfg = resolveRedisConfig();
  console.log(`  ↳ Redis target: ${redisCfg.displayHost}`);
  try {
    await validateRedisConnection(8_000);
    console.log("  ✓ Redis Connected");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ✗ Redis connection FAILED — cannot start without Redis.\n`);
    console.error(message);
    console.error(`\n  Fix: ensure Redis is running on ${redisCfg.displayHost}`);
    console.error("        or set REDIS_URL / REDIS_HOST / REDIS_PASSWORD in .env\n");
    process.exit(1);
  }

  // ── 3. Create BullMQ Worker ──────────────────────────────────────────────────
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

  console.log(`  ✓ Queue Ready    →  ${SCRAPE_QUEUE_NAME} (concurrency=${WORKER_CONCURRENCY})`);
  
  let dedupWorker: any = null;
  try {
    dedupWorker = startDedupWorker();
  } catch (err: any) {
    console.warn("  ⚠ Failed to start Deduplication Worker:", err.message);
  }

  console.log(LINE);

  worker.on("completed", async (job) => {
    console.log(`[Worker] ✅ Job ${job.id} (runId=${job.data.scrapeRunId}) completed`);

    // 1. Deduplication (existing)
    try {
      await enqueueDedupJob();
    } catch (err: any) {
      console.error("[Worker] ⚠️ Failed to enqueue deduplication job:", err.message);
    }

    // 2. Startup Intelligence enrichment — automatically triggered after every scrape
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

    // 3. Company News collection — automatically triggered after every scrape
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
    console.warn(`[Worker] ⚠️  Job ${jobId} stalled — will be retried`);
  });

  worker.on("error", (err) => {
    console.error("[Worker] ❌ Worker error:", err.message);
  });

  worker.on("active", (job) => {
    console.log(`[Worker] 🏃 Job ${job.id} started (runId=${job.data.scrapeRunId})`);
  });

  console.log(`\n  Waiting for jobs... (Ctrl+C to stop)\n`);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[Worker] 📨 Received ${signal} — gracefully shutting down...`);
    await logger.workerStopped();
    if (dedupWorker) {
      await dedupWorker.close().catch(() => {});
    }
    await worker.close();
    await closeRedisConnection();
    await closeConnection();
    console.log("[Worker] 👋 Worker stopped.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("[Worker] 💥 Fatal bootstrap error:", err);
  process.exit(1);
});
