import { Collection, ObjectId } from "mongodb";
import { getDb } from "../connection.js";
import { JobDocument } from "../models/Job.js";

const COLLECTION = "jobs";

async function col(): Promise<Collection<JobDocument>> {
  const db = await getDb();
  return db.collection<JobDocument>(COLLECTION);
}

/**
 * Ensures indexes exist for the jobs collection.
 * Call once at startup.
 */
export async function ensureJobIndexes(): Promise<void> {
  const c = await col();
  await c.createIndex({ jobUrl: 1 }, { unique: true, background: true });
  await c.createIndex({ companyId: 1 }, { background: true });
  await c.createIndex({ scrapeRunId: 1 }, { background: true });
}

/**
 * Upsert a job posting by its unique `jobUrl`.
 * Returns the _id of the matched or inserted document.
 */
export async function upsertJob(
  job: Omit<JobDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();

  const result = await c.findOneAndUpdate(
    { jobUrl: job.jobUrl },
    {
      $set: { ...job, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );

  return result!._id as ObjectId;
}

/** Find all jobs belonging to a company. */
export async function findJobsByCompany(companyId: ObjectId): Promise<JobDocument[]> {
  const c = await col();
  return c.find({ companyId }).toArray();
}

/** Find all jobs scraped during a specific run. */
export async function findJobsByScrapeRun(scrapeRunId: ObjectId): Promise<JobDocument[]> {
  const c = await col();
  return c.find({ scrapeRunId }).toArray();
}

/** Find a job by its URL. */
export async function findJobByUrl(jobUrl: string): Promise<JobDocument | null> {
  const c = await col();
  return c.findOne({ jobUrl });
}
