import { Collection, ObjectId } from "mongodb";
import { getDb } from "../connection.ts";
import { ScrapeRunDocument, ScrapeRunStatus } from "../models/ScrapeRun.ts";

const COLLECTION = "scrape_runs";

async function col(): Promise<Collection<ScrapeRunDocument>> {
  const db = await getDb();
  return db.collection<ScrapeRunDocument>(COLLECTION);
}

// ─── Index Setup ──────────────────────────────────────────────────────────────

/**
 * Ensures indexes exist for the scrape_runs collection.
 * Call once at startup.
 */
export async function ensureScrapeRunIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ startedAt: -1 }, { background: true }),
    c.createIndex({ status: 1 }, { background: true }),
    c.createIndex({ queueJobId: 1 }, { background: true, sparse: true }),
  ]);
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Creates a new scrape run record with status "queued".
 * Called immediately when the API receives a start request — BEFORE enqueuing.
 * Returns the new run's _id.
 */
export async function createQueuedScrapeRun(
  config: Pick<
    ScrapeRunDocument,
    | "country"
    | "state"
    | "city"
    | "sector"
    | "selectedSources"
    | "remoteOnly"
    | "jobType"
    | "maxPages"
    | "keywords"
    | "searchQueries"
    | "locations"
    | "outputFile"
  >
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();
  const result = await c.insertOne({
    ...config,
    portals: config.selectedSources,
    status: "queued" as ScrapeRunStatus,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    progress: 0,
    currentStage: "queued",
    jobsFound: 0,
    companiesFound: 0,
    leadsFound: 0,
    retryCount: 0,
    rawLeadsFound: 0,
    uniqueCompanies: 0,
    enrichedLeads: 0,
    filteredLeads: 0,
    hotLeads: 0,
    warmLeads: 0,
    coldLeads: 0,
  } as ScrapeRunDocument);
  return result.insertedId;
}

/**
 * Creates a new scrape run record with status "running" (legacy — used by CLI).
 * Returns the newly created run's _id.
 */
export async function startScrapeRun(
  config: Pick<
    ScrapeRunDocument,
    "portals" | "searchQueries" | "locations" | "outputFile"
  >
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();
  const result = await c.insertOne({
    ...config,
    status: "running" as ScrapeRunStatus,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    progress: 0,
    currentStage: "scraping",
    jobsFound: 0,
    companiesFound: 0,
    leadsFound: 0,
  } as ScrapeRunDocument);
  return result.insertedId;
}

// ─── Status Transitions ───────────────────────────────────────────────────────

/**
 * Marks the run as running when the BullMQ worker picks it up.
 * Associates the BullMQ job ID with the run document.
 */
export async function markRunning(
  id: ObjectId,
  queueJobId: string,
  attemptNumber: number
): Promise<void> {
  const c = await col();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: "running" as ScrapeRunStatus,
        queueJobId,
        retryCount: attemptNumber - 1, // attempt 1 = first try = 0 retries
        currentStage: "scraping",
        progress: 5,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Updates real-time progress fields during scraping.
 * Called by the worker's onProgress callback on each milestone.
 */
export async function updateScrapeRunProgress(
  id: ObjectId,
  update: {
    progress?: number;
    currentStage?: string;
    currentSource?: string;
    jobsFound?: number;
    companiesFound?: number;
    leadsFound?: number;
  }
): Promise<void> {
  const c = await col();
  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  if (update.progress !== undefined) setFields.progress = update.progress;
  if (update.currentStage !== undefined) setFields.currentStage = update.currentStage;
  if (update.currentSource !== undefined) setFields.currentSource = update.currentSource;
  if (update.jobsFound !== undefined) setFields.jobsFound = update.jobsFound;
  if (update.companiesFound !== undefined) setFields.companiesFound = update.companiesFound;
  if (update.leadsFound !== undefined) setFields.leadsFound = update.leadsFound;
  await c.updateOne({ _id: id }, { $set: setFields });
}

/**
 * Marks a scrape run as completed and records final statistics.
 */
export async function completeScrapeRun(
  id: ObjectId,
  stats: Partial<
    Pick<
      ScrapeRunDocument,
      | "rawLeadsFound"
      | "uniqueCompanies"
      | "enrichedLeads"
      | "filteredLeads"
      | "hotLeads"
      | "warmLeads"
      | "coldLeads"
    >
  >
): Promise<void> {
  const c = await col();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        ...stats,
        status: "completed" as ScrapeRunStatus,
        progress: 100,
        currentStage: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Marks a scrape run as failed with an error message.
 */
export async function failScrapeRun(
  id: ObjectId,
  errorMessage: string,
  stackTrace?: string
): Promise<void> {
  const c = await col();
  await c.updateOne(
    { _id: id },
    {
      $set: {
        status: "failed" as ScrapeRunStatus,
        errorMessage,
        stackTrace,
        completedAt: new Date(),
        updatedAt: new Date(),
        currentStage: "failed",
      },
    }
  );
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Retrieve the most recent N scrape runs. */
export async function listRecentRuns(n = 20): Promise<ScrapeRunDocument[]> {
  const c = await col();
  return c.find({}).sort({ startedAt: -1 }).limit(n).toArray();
}

/** Paginated listing of scrape runs with optional status filter. */
export async function listScrapeRuns(
  page = 1,
  limit = 20,
  filters: { status?: string; country?: string; sector?: string } = {}
): Promise<{ data: ScrapeRunDocument[]; total: number }> {
  const c = await col();
  const query: Record<string, unknown> = {};
  if (filters.status) query.status = filters.status;
  if (filters.country) query.country = filters.country;
  if (filters.sector) query.sector = filters.sector;

  const [data, total] = await Promise.all([
    c
      .find(query)
      .sort({ startedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    c.countDocuments(query),
  ]);
  return { data, total };
}

/** Retrieve a scrape run by _id. */
export async function findScrapeRunById(
  id: ObjectId
): Promise<ScrapeRunDocument | null> {
  const c = await col();
  return c.findOne({ _id: id });
}

/** Find currently queued or running scrape run (at most one should be active). */
export async function findActiveScrapeRun(): Promise<ScrapeRunDocument | null> {
  const c = await col();
  return c.findOne(
    { status: { $in: ["queued", "running"] } },
    { sort: { startedAt: -1 } }
  );
}

/** Count active scrape runs (queued or running). */
export async function countActiveScrapeRuns(): Promise<number> {
  const c = await col();
  return c.countDocuments({ status: { $in: ["queued", "running"] } });
}

/** Retrieve daily scrape activity for the last N days. */
export async function getDailyScrapeActivity(days = 14): Promise<{ date: string; runs: number; leads: number; companies: number }[]> {
  const c = await col();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const results = await c.aggregate<any>([
    { $match: { startedAt: { $gte: startDate } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$startedAt" } },
        runs: { $sum: 1 },
        leads: { $sum: { $ifNull: ["$filteredLeads", { $ifNull: ["$leadsFound", 0] }] } },
        companies: { $sum: { $ifNull: ["$uniqueCompanies", { $ifNull: ["$companiesFound", 0] }] } }
      }
    },
    { $project: { _id: 0, date: "$_id", runs: 1, leads: 1, companies: 1 } },
    { $sort: { date: 1 } }
  ]).toArray();

  return results;
}

/** Retrieve scrape run success/failure statistics. */
export async function getScrapeSuccessMetrics(): Promise<{
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  successRate: number;
}> {
  const c = await col();
  const totalRuns = await c.countDocuments({});
  if (totalRuns === 0) {
    return { totalRuns: 0, successRuns: 0, failedRuns: 0, successRate: 0 };
  }

  const successRuns = await c.countDocuments({ status: "completed" });
  const failedRuns = await c.countDocuments({ status: "failed" });

  return {
    totalRuns,
    successRuns,
    failedRuns,
    successRate: Math.round((successRuns / totalRuns) * 1000) / 10
  };
}


