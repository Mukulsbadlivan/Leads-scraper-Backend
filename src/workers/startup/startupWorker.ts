/**
 * startupWorker.ts — BullMQ Worker for startup intelligence jobs.
 *
 * Exports startStartupWorker() so it can be called by workerManager.ts
 * when the backend server boots (in-process worker mode).
 *
 * This module:
 *   - Creates the BullMQ Worker for STARTUP_QUEUE_NAME
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
import { STARTUP_QUEUE_NAME, StartupJobPayload } from "../../queue/startupQueue.ts";
import { runStartupDiscovery } from "../../services/startup/StartupDiscovery.ts";
import { enrichStartupBatch } from "../../services/startup/StartupEnricher.ts";
import { scoreAndSaveStartupLead } from "../../services/startup/StartupScorer.ts";
import { deduplicateStartupCompanies } from "../../services/startup/StartupDeduplicator.ts";
import { listStartupCompaniesForEnrichment } from "../../database/repositories/StartupCompanyRepository.ts";
import { findExecutivesByCompany } from "../../database/repositories/StartupExecutiveRepository.ts";
import { ObjectId } from "mongodb";

const CONCURRENCY = parseInt(process.env.STARTUP_WORKER_CONCURRENCY ?? "1", 10);

// ─── Job Progress Tracker ──────────────────────────────────────────────────────

interface WorkerProgress {
  stage: string;
  companiesDiscovered: number;
  companiesEnriched: number;
  executivesFound: number;
  startedAt: Date;
}

// ─── Job Handler ──────────────────────────────────────────────────────────────

async function processStartupJob(job: Job<StartupJobPayload>): Promise<void> {
  const { jobRunId, sources, sectors, stages, maxCompanies, enrichExecutives } = job.data;
  const progress: WorkerProgress = {
    stage: "Initializing",
    companiesDiscovered: 0,
    companiesEnriched: 0,
    executivesFound: 0,
    startedAt: new Date(),
  };

  const updateProgress = async (stage: string) => {
    progress.stage = stage;
    await job.updateProgress({ ...progress, stage });
    console.log(`[StartupWorker][${jobRunId}] ${stage}`);
  };

  await updateProgress("Discovery Phase");

  // Phase 1: Discovery
  const discoveryResult = await runStartupDiscovery({
    sources: sources ?? ["existing_companies", "yc", "wellfound", "rss", "crunchbase"],
    sectors,
    stages,
    maxCompanies: maxCompanies ?? 200,
    onProgress: (msg, count) => {
      progress.companiesDiscovered = count;
      job.updateProgress({ ...progress, stage: `Discovery: ${msg}` }).catch(() => {});
    },
  });

  progress.companiesDiscovered = discoveryResult.discovered;
  await updateProgress("Deduplication Phase");

  // Phase 2: Deduplication
  await deduplicateStartupCompanies();

  // Phase 3: Enrichment (executives)
  if (enrichExecutives !== false) {
    await updateProgress("Executive Enrichment Phase");

    const freshness = parseInt(process.env.STARTUP_FRESHNESS_HOURS ?? "24", 10);
    const companies = await listStartupCompaniesForEnrichment(freshness, 100);

    const enrichResult = await enrichStartupBatch(
      companies as any,
      (done, total) => {
        progress.companiesEnriched = done;
        job.updateProgress({ ...progress, stage: `Enriching (${done}/${total})` }).catch(() => {});
      }
    );

    progress.companiesEnriched = enrichResult.totalEnriched;
    progress.executivesFound = enrichResult.totalExecutives;
  }

  // Phase 4: Scoring — score all enriched companies
  await updateProgress("Scoring Phase");

  const scoringCandidates = await listStartupCompaniesForEnrichment(999999, 1000);
  for (const company of scoringCandidates) {
    if (!company._id) continue;
    try {
      const executives = await findExecutivesByCompany(company._id as ObjectId);
      await scoreAndSaveStartupLead(company as any, executives);
    } catch (err: any) {
      console.warn(`[StartupWorker] Score error for ${company.companyName}: ${err.message}`);
    }
  }

  await updateProgress("Complete");
  console.log(
    `[StartupWorker][${jobRunId}] Done. ` +
    `Discovered=${progress.companiesDiscovered} ` +
    `Enriched=${progress.companiesEnriched} ` +
    `Executives=${progress.executivesFound}`
  );
}

// ─── Worker Factory ───────────────────────────────────────────────────────────

/**
 * Creates and starts the BullMQ startup intelligence worker.
 *
 * Called by workerManager.startAllWorkers() during server bootstrap.
 * MongoDB and Redis must already be connected before calling this.
 *
 * @returns The Worker instance (caller is responsible for .close() on shutdown).
 */
export function startStartupWorker(): Worker<StartupJobPayload> {
  const worker = new Worker<StartupJobPayload>(
    STARTUP_QUEUE_NAME,
    processStartupJob,
    {
      connection: createRedisConnection() as any,
      concurrency: CONCURRENCY,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[StartupWorker] ✅ Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[StartupWorker] ❌ Job ${job?.id} failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error(`[StartupWorker] Worker error: ${err.message}`);
  });

  return worker;
}
