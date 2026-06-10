/**
 * CompanyNewsRepository.ts — CRUD for the `company_news` collection.
 * ISOLATED — does not touch the existing `signals` collection.
 * Deduplication is enforced via a unique index on `contentHash`.
 */
import { Collection, ObjectId, Filter } from "mongodb";
import { createHash } from "crypto";
import { getDb } from "../connection.ts";
import { CompanyNewsDocument, NewsEventType } from "../models/CompanyNews.ts";

const COLLECTION = "company_news";

async function col(): Promise<Collection<CompanyNewsDocument>> {
  const db = await getDb();
  return db.collection<CompanyNewsDocument>(COLLECTION);
}

export async function ensureCompanyNewsIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ contentHash: 1 }, { unique: true, background: true }),
    c.createIndex({ startupCompanyId: 1 }, { background: true }),
    c.createIndex({ existingCompanyId: 1 }, { sparse: true, background: true }),
    c.createIndex({ eventType: 1 }, { background: true }),
    c.createIndex({ publishedAt: -1 }, { background: true }),
    c.createIndex({ companyName: 1 }, { background: true }),
  ]);
}

/** Generates a deterministic dedup hash from title + url. */
export function buildContentHash(title: string, url: string): string {
  return createHash("sha256")
    .update(`${title.trim().toLowerCase()}::${url.trim().toLowerCase()}`)
    .digest("hex");
}

/**
 * Insert a news article. Skips silently if contentHash already exists (dedup).
 * Returns the _id if inserted, or null if a duplicate was detected.
 */
export async function insertCompanyNews(
  doc: Omit<CompanyNewsDocument, "_id" | "contentHash"> & { contentHash?: string }
): Promise<ObjectId | null> {
  const c = await col();
  const now = new Date();
  const hash = doc.contentHash ?? buildContentHash(doc.title, doc.url);

  try {
    const result = await c.insertOne({
      ...doc,
      contentHash: hash,
      fetchedAt: now,
      createdAt: now,
      updatedAt: now,
    } as CompanyNewsDocument);
    return result.insertedId;
  } catch (err: any) {
    // E11000 = duplicate key (contentHash unique index) — skip silently
    if (err.code === 11000) return null;
    throw err;
  }
}

/** Batch insert news articles, skipping duplicates. Returns count inserted. */
export async function insertManyCompanyNews(
  docs: (Omit<CompanyNewsDocument, "_id" | "contentHash"> & { contentHash?: string })[]
): Promise<number> {
  if (docs.length === 0) return 0;
  let inserted = 0;
  for (const doc of docs) {
    const id = await insertCompanyNews(doc);
    if (id) inserted++;
  }
  return inserted;
}

export async function countCompanyNews(
  filter: Filter<CompanyNewsDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

export async function listCompanyNewsPaginated(
  page = 1,
  limit = 25,
  filter: Filter<CompanyNewsDocument> = {}
): Promise<CompanyNewsDocument[]> {
  const c = await col();
  const skip = (page - 1) * limit;
  return c
    .find(filter)
    .sort({ publishedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

export async function findNewsByCompany(
  startupCompanyId: ObjectId,
  limit = 20
): Promise<CompanyNewsDocument[]> {
  const c = await col();
  return c
    .find({ startupCompanyId })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .toArray();
}

export async function findNewsByEventType(
  eventType: NewsEventType,
  limit = 50
): Promise<CompanyNewsDocument[]> {
  const c = await col();
  return c
    .find({ eventType })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .toArray();
}

export async function newsHashExists(contentHash: string): Promise<boolean> {
  const c = await col();
  const count = await c.countDocuments({ contentHash });
  return count > 0;
}
