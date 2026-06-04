import { Collection, ObjectId } from "mongodb";
import { getDb } from "../connection.js";
import { SignalDocument, SignalCategory } from "../models/Signal.js";

const COLLECTION = "signals";

async function col(): Promise<Collection<SignalDocument>> {
  const db = await getDb();
  return db.collection<SignalDocument>(COLLECTION);
}

/**
 * Ensures indexes exist for the signals collection.
 * Call once at startup.
 */
export async function ensureSignalIndexes(): Promise<void> {
  const c = await col();
  await c.createIndex({ companyId: 1 }, { background: true });
  await c.createIndex({ category: 1 }, { background: true });
  await c.createIndex({ scrapeRunId: 1 }, { background: true });
}

/**
 * Insert a new signal document.
 * Returns the inserted document's _id.
 */
export async function insertSignal(
  signal: Omit<SignalDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();
  const result = await c.insertOne({
    ...signal,
    detectedAt: signal.detectedAt ?? now,
    createdAt: now,
    updatedAt: now,
  } as SignalDocument);
  return result.insertedId;
}

/** Find all signals for a given company. */
export async function findSignalsByCompany(
  companyId: ObjectId,
  category?: SignalCategory
): Promise<SignalDocument[]> {
  const c = await col();
  const filter: Record<string, unknown> = { companyId };
  if (category) filter.category = category;
  return c.find(filter).sort({ detectedAt: -1 }).toArray();
}

/** Find all signals captured during a scrape run. */
export async function findSignalsByScrapeRun(
  scrapeRunId: ObjectId
): Promise<SignalDocument[]> {
  const c = await col();
  return c.find({ scrapeRunId }).toArray();
}
