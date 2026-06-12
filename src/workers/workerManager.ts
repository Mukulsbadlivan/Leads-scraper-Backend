/**
 * workerManager.ts — In-process BullMQ worker orchestrator.
 *
 * Starts ALL BullMQ workers inside the same Node process as the Express server.
 * Replaces the three separate Render worker services with a single call during
 * server bootstrap.
 *
 * Startup contract (called AFTER MongoDB + Redis are confirmed live):
 *   1. startScrapeWorker()       → "scrape-jobs" queue
 *   2. startDedupWorker()        → "deduplication-jobs" queue
 *   3. startStartupWorker()      → "startup-intelligence-jobs" queue
 *   4. startCompanyNewsWorker()  → "company-news-jobs" queue
 *
 * Returns a shutdown() function that closes all workers gracefully.
 * Guards against double-initialisation — safe to import this module multiple times.
 */

import type { Worker } from "bullmq";
import { startScrapeWorker } from "./scrapeWorker.ts";
import { startDedupWorker } from "./dedupWorker.ts";
import { startStartupWorker } from "./startup/startupWorker.ts";
import { startCompanyNewsWorker } from "./companyNews/companyNewsWorker.ts";

// ─── Singleton guard ──────────────────────────────────────────────────────────

let started = false;
let workerInstances: Worker[] = [];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts all BullMQ workers in the current process.
 *
 * @returns shutdown() — closes all workers cleanly (call on SIGTERM/SIGINT).
 *
 * Safe to call multiple times — subsequent calls are a no-op.
 */
export async function startAllWorkers(): Promise<() => Promise<void>> {
  if (started) {
    console.warn("[WorkerManager] ⚠ Workers already running — skipping duplicate init");
    return shutdownAll;
  }

  const LINE = "─".repeat(50);
  console.log(`\n${LINE}`);
  console.log("  ICP Lead Intelligence — Starting In-Process Workers");
  console.log(LINE);

  const workers: Worker[] = [];

  // ── 1. Scrape Worker ────────────────────────────────────────────────────────
  try {
    const w = startScrapeWorker();
    workers.push(w);
    console.log("  ✓ Scrape Worker      →  scrape-jobs");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Scrape Worker failed to start: ${msg}`);
  }

  // ── 2. Dedup Worker ─────────────────────────────────────────────────────────
  try {
    const w = startDedupWorker();
    workers.push(w);
    console.log("  ✓ Dedup Worker       →  deduplication-jobs");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Dedup Worker failed to start: ${msg}`);
  }

  // ── 3. Startup Intelligence Worker ──────────────────────────────────────────
  try {
    const w = startStartupWorker();
    workers.push(w);
    console.log("  ✓ Startup Worker     →  startup-intelligence-jobs");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Startup Worker failed to start: ${msg}`);
  }

  // ── 4. Company News Worker ──────────────────────────────────────────────────
  try {
    const w = startCompanyNewsWorker();
    workers.push(w);
    console.log("  ✓ News Worker        →  company-news-jobs");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Company News Worker failed to start: ${msg}`);
  }

  console.log(LINE);
  console.log(`  ${workers.length}/4 workers running in-process\n`);

  workerInstances = workers;
  started = true;

  return shutdownAll;
}

/**
 * Closes all running BullMQ workers gracefully.
 * Waits for in-flight jobs to complete (up to BullMQ's default timeout).
 */
async function shutdownAll(): Promise<void> {
  if (!started || workerInstances.length === 0) return;
  console.log("[WorkerManager] Closing all workers...");
  await Promise.allSettled(workerInstances.map((w) => w.close()));
  workerInstances = [];
  started = false;
  console.log("[WorkerManager] All workers closed.");
}
