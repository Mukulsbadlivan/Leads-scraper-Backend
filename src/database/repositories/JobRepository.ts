import { Collection, ObjectId, Filter } from "mongodb";
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

/** Count jobs matching filters. */
export async function countJobs(
  filter: Filter<JobDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

/** Retrieve jobs matching filters with pagination. */
export async function listJobsPaginated(
  page = 1,
  limit = 25,
  filter: Filter<JobDocument> = {}
): Promise<JobDocument[]> {
  const c = await col();
  const skip = (page - 1) * limit;
  return c.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
}

/** Retrieve jobs count grouped by source. */
export async function getJobsBySource(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { source: { $nin: [null, ""] } } },
    { $group: { _id: "$source", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } }
  ]).toArray();
}

/** Retrieve jobs count grouped by location. */
export async function getJobsByLocation(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { location: { $nin: [null, ""] } } },
    { $group: { _id: "$location", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } },
    { $limit: 10 }
  ]).toArray();
}

/** Retrieve top hiring companies by active job counts. */
export async function getTopHiringCompanies(limit = 10): Promise<{ name: string; count: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; count: number }>([
    { $match: { companyName: { $nin: [null, ""] } } },
    { $group: { _id: "$companyName", count: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", count: 1 } },
    { $sort: { count: -1 } },
    { $limit: limit }
  ]).toArray();
}

/** Retrieve jobs count grouped by sector. */
export async function getJobsBySector(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { sector: { $nin: [null, ""] } } },
    { $group: { _id: "$sector", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } }
  ]).toArray();
}


