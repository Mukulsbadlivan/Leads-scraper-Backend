import { Collection, ObjectId } from "mongodb";
import { getDb } from "../connection.ts";
import { DuplicateAuditDocument } from "../models/DuplicateAudit.ts";

const COLLECTION = "duplicate_audit";

async function col(): Promise<Collection<DuplicateAuditDocument>> {
  const db = await getDb();
  return db.collection<DuplicateAuditDocument>(COLLECTION);
}

/**
 * Ensures indexes exist for the duplicate_audit collection.
 */
export async function ensureDuplicateAuditIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ sourceCollection: 1 }, { background: true }),
    c.createIndex({ mergedAt: -1 }, { background: true })
  ]);
}

/**
 * Inserts a duplicate audit log entry.
 */
export async function insertDuplicateAudit(
  audit: Omit<DuplicateAuditDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const doc = {
    ...audit,
    mergedAt: audit.mergedAt || new Date()
  } as DuplicateAuditDocument;
  
  const result = await c.insertOne(doc);
  return result.insertedId;
}

/**
 * Counts the total number of duplicates removed.
 * Optionally filters by source collection.
 */
export async function countDuplicatesRemoved(
  collection?: "companies" | "leads"
): Promise<number> {
  const c = await col();
  const filter: any = {};
  if (collection) {
    filter.sourceCollection = collection;
  }
  return c.countDocuments(filter);
}
