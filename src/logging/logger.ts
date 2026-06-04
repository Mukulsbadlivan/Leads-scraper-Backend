/**
 * logger.ts — Structured logging with MongoDB persistence.
 *
 * Logs are written to the `scrape_logs` collection in MongoDB AND to console.
 * This dual-write approach ensures logs are available even if MongoDB is unavailable
 * (console fallback) and queryable for dashboards (MongoDB).
 */
import { Collection } from "mongodb";
import { getDb } from "../database/connection.ts";
import { LogDocument, LogEventType, LogLevel } from "../database/models/Log.ts";

const LOG_COLLECTION = "scrape_logs";
const MAX_PAYLOAD_SIZE = 10_000; // chars — prevent runaway log documents

// ─── Internal write ───────────────────────────────────────────────────────────

async function getCollection(): Promise<Collection<LogDocument>> {
  const db = await getDb();
  return db.collection<LogDocument>(LOG_COLLECTION);
}

let dbAvailable = true; // optimistic — flips to false on first failure

async function persistLog(doc: LogDocument): Promise<void> {
  if (!dbAvailable) return;
  try {
    const c = await getCollection();
    await c.insertOne(doc);
  } catch {
    dbAvailable = false; // Stop trying after first failure to avoid cascading errors
  }
}

function formatConsole(doc: LogDocument): string {
  const ts = new Date().toISOString();
  const extras: string[] = [];
  if (doc.scrapeRunId) extras.push(`runId=${doc.scrapeRunId.slice(-8)}`);
  if (doc.queueJobId) extras.push(`jobId=${doc.queueJobId}`);
  if (doc.attemptNumber !== undefined) extras.push(`attempt=${doc.attemptNumber}`);
  const extStr = extras.length ? ` [${extras.join(" ")}]` : "";
  return `[${ts}] [${doc.level.toUpperCase()}] [${doc.event}]${extStr} ${doc.message}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LogOptions {
  scrapeRunId?: string;
  queueJobId?: string;
  attemptNumber?: number;
  payload?: Record<string, unknown>;
  errorMessage?: string;
  stackTrace?: string;
}

export async function log(
  event: LogEventType,
  level: LogLevel,
  message: string,
  opts: LogOptions = {}
): Promise<void> {
  const doc: LogDocument = {
    event,
    level,
    message,
    scrapeRunId: opts.scrapeRunId,
    queueJobId: opts.queueJobId,
    attemptNumber: opts.attemptNumber,
    payload: opts.payload
      ? JSON.parse(JSON.stringify(opts.payload).slice(0, MAX_PAYLOAD_SIZE))
      : undefined,
    errorMessage: opts.errorMessage,
    stackTrace: opts.stackTrace?.slice(0, 5000),
    createdAt: new Date(),
  };

  // Console output always
  if (level === "error") console.error(formatConsole(doc));
  else if (level === "warn") console.warn(formatConsole(doc));
  else console.log(formatConsole(doc));

  // MongoDB persistence (async, best-effort)
  persistLog(doc).catch(() => {}); // swallow — console already has it
}

// ─── Convenience methods ──────────────────────────────────────────────────────

export const logger = {
  queueCreated: (scrapeRunId: string, queueJobId: string) =>
    log("QueueCreated", "info", "Scrape job enqueued", { scrapeRunId, queueJobId }),

  workerStarted: () =>
    log("WorkerStarted", "info", "BullMQ worker started and listening for jobs"),

  workerStopped: () =>
    log("WorkerStopped", "warn", "BullMQ worker stopped"),

  jobStarted: (scrapeRunId: string, queueJobId: string, attemptNumber: number) =>
    log("JobStarted", "info", `Worker picked up scrape job`, {
      scrapeRunId,
      queueJobId,
      attemptNumber,
    }),

  jobProgress: (scrapeRunId: string, progress: number, stage: string, opts: LogOptions = {}) =>
    log("JobProgress", "info", `Progress ${progress}% — ${stage}`, {
      ...opts,
      scrapeRunId,
      payload: { progress, stage, ...opts.payload },
    }),

  jobCompleted: (scrapeRunId: string, queueJobId: string, stats: Record<string, unknown>) =>
    log("JobCompleted", "info", "Scrape job completed successfully", {
      scrapeRunId,
      queueJobId,
      payload: stats,
    }),

  jobFailed: (scrapeRunId: string, queueJobId: string, error: Error, attemptNumber: number) =>
    log("JobFailed", "error", `Scrape job failed: ${error.message}`, {
      scrapeRunId,
      queueJobId,
      attemptNumber,
      errorMessage: error.message,
      stackTrace: error.stack,
    }),

  retryAttempt: (scrapeRunId: string, queueJobId: string, attemptNumber: number, nextDelay: number) =>
    log("RetryAttempt", "warn", `Retrying in ${nextDelay}ms (attempt ${attemptNumber})`, {
      scrapeRunId,
      queueJobId,
      attemptNumber,
      payload: { nextDelayMs: nextDelay },
    }),

  deadLetterQueue: (scrapeRunId: string, errorMessage: string) =>
    log("DeadLetterQueue", "error", `Job moved to DLQ after all retries: ${errorMessage}`, {
      scrapeRunId,
      errorMessage,
    }),

  apiRequest: (method: string, path: string, statusCode: number) =>
    log("ApiRequest", "info", `${method} ${path} → ${statusCode}`),
};

// ─── Index setup ──────────────────────────────────────────────────────────────

export async function ensureLogIndexes(): Promise<void> {
  try {
    const c = await getCollection();
    await Promise.all([
      c.createIndex({ createdAt: -1 }, { background: true }),
      c.createIndex({ event: 1 }, { background: true }),
      c.createIndex({ scrapeRunId: 1 }, { background: true, sparse: true }),
      c.createIndex({ level: 1 }, { background: true }),
    ]);
  } catch {
    // Non-fatal
  }
}
