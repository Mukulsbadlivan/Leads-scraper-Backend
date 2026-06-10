/**
 * StartupCompanyRepository.ts — CRUD + upsert operations for the
 * `startup_companies` collection.
 *
 * ISOLATED — never reads from or writes to the existing `companies` collection.
 * Cross-reference to existing companies is maintained via the optional
 * `existingCompanyId` field (read-only FK, populated during enrichment).
 */
import { Collection, ObjectId, Filter } from "mongodb";
import { getDb } from "../connection.ts";
import { StartupCompanyDocument } from "../models/StartupCompany.ts";

const COLLECTION = "startup_companies";

async function col(): Promise<Collection<StartupCompanyDocument>> {
  const db = await getDb();
  return db.collection<StartupCompanyDocument>(COLLECTION);
}

// ─── Index Setup ──────────────────────────────────────────────────────────────

export async function ensureStartupCompanyIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ website: 1 }, { sparse: true, background: true }),
    c.createIndex({ normalizedName: 1 }, { sparse: true, background: true }),
    c.createIndex({ linkedinUrl: 1 }, { sparse: true, background: true }),
    c.createIndex({ existingCompanyId: 1 }, { sparse: true, background: true }),
    c.createIndex({ companyStage: 1 }, { background: true }),
    c.createIndex({ isYCBacked: 1 }, { background: true }),
    c.createIndex({ lastEnrichedAt: 1 }, { background: true }),
    c.createIndex({ dataQualityScore: -1 }, { background: true }),
    c.createIndex({ sector: 1 }, { background: true }),
    c.createIndex({ country: 1 }, { background: true }),
  ]);
}

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(inc|llc|ltd|corp|co|group|technologies|solutions|labs|ventures)\b/g, "")
    .trim();
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Upserts a startup company. Deduplication order:
 * 1. website match
 * 2. normalizedName match
 * 3. linkedinUrl match
 *
 * Merges incoming data with existing record (existing wins on non-empty fields).
 * Returns the _id of the matched or inserted document.
 */
export async function upsertStartupCompany(
  company: Omit<StartupCompanyDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();
  const normName = normalizeCompanyName(company.companyName || "");

  const incoming: Omit<StartupCompanyDocument, "_id"> = {
    ...company,
    normalizedName: normName,
    updatedAt: now,
  };

  // Build dedup query
  const orConditions: Filter<StartupCompanyDocument>[] = [];
  if (company.website) orConditions.push({ website: company.website });
  if (normName) orConditions.push({ normalizedName: normName });
  if (company.linkedinUrl) orConditions.push({ linkedinUrl: company.linkedinUrl });

  let existing: StartupCompanyDocument | null = null;
  if (orConditions.length > 0) {
    existing = await c.findOne({ $or: orConditions });
  }

  if (existing) {
    // Merge: prefer non-empty incoming fields, but never overwrite with empty
    const merged: Partial<StartupCompanyDocument> = { updatedAt: now };
    const mergeField = (key: keyof StartupCompanyDocument) => {
      const inVal = (incoming as any)[key];
      const exVal = (existing as any)[key];
      if (inVal !== undefined && inVal !== null && inVal !== "") {
        (merged as any)[key] = Array.isArray(inVal)
          ? inVal.length > 0 ? inVal : exVal
          : inVal;
      }
    };

    const fields: (keyof StartupCompanyDocument)[] = [
      "companyName", "normalizedName", "website", "linkedinUrl", "linkedinCompanySlug",
      "linkedinCompanyId", "linkedinFollowers", "foundingYear", "foundedDate",
      "isYCBacked", "ycBatch", "wellfoundUrl", "crunchbaseUrl", "industry",
      "sector", "companyStage", "companySize", "headcount", "country", "state",
      "city", "hqLocation", "jobLinks", "hiringRoles", "hiringVelocity",
      "hiringSignals", "growthSignals", "techStack", "existingCompanyId",
      "dataQualityScore", "sourceTracking", "lastEnrichedAt",
    ];
    fields.forEach(mergeField);

    await c.updateOne({ _id: existing._id }, { $set: merged });
    return existing._id as ObjectId;
  }

  // Insert new
  const result = await c.insertOne({ ...incoming, createdAt: now } as StartupCompanyDocument);
  return result.insertedId;
}

// ─── Read Operations ──────────────────────────────────────────────────────────

export async function findStartupCompanyById(
  id: ObjectId
): Promise<StartupCompanyDocument | null> {
  const c = await col();
  return c.findOne({ _id: id });
}

export async function findStartupCompanyByWebsite(
  website: string
): Promise<StartupCompanyDocument | null> {
  const c = await col();
  return c.findOne({ website });
}

export async function countStartupCompanies(
  filter: Filter<StartupCompanyDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

export async function listStartupCompaniesPaginated(
  page = 1,
  limit = 25,
  filter: Filter<StartupCompanyDocument> = {},
  sortBy = "dataQualityScore",
  sortOrder: 1 | -1 = -1
): Promise<any[]> {
  const c = await col();
  const skip = (page - 1) * limit;

  const pipeline = [
    { $match: filter },
    {
      $lookup: {
        from: "startup_executives",
        localField: "_id",
        foreignField: "startupCompanyId",
        as: "executiveDocs",
      },
    },
    {
      $lookup: {
        from: "company_news",
        localField: "_id",
        foreignField: "startupCompanyId",
        as: "newsDocs",
      },
    },
    {
      $addFields: {
        executivesCount: { $size: "$executiveDocs" },
        newsCount: { $size: "$newsDocs" },
      },
    },
    { $unset: ["executiveDocs", "newsDocs"] },
    { $sort: { [sortBy]: sortOrder } as any },
    { $skip: skip },
    { $limit: limit },
  ];

  return c.aggregate(pipeline).toArray();
}

export async function getStartupCompaniesBySector(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c
    .aggregate<{ name: string; value: number }>([
      { $match: { sector: { $nin: [null, ""] } } },
      { $group: { _id: "$sector", value: { $sum: 1 } } },
      { $project: { _id: 0, name: "$_id", value: 1 } },
      { $sort: { value: -1 } },
    ])
    .toArray();
}

export async function getStartupCompaniesByStage(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c
    .aggregate<{ name: string; value: number }>([
      { $match: { companyStage: { $nin: [null, ""] } } },
      { $group: { _id: "$companyStage", value: { $sum: 1 } } },
      { $project: { _id: 0, name: "$_id", value: 1 } },
      { $sort: { value: -1 } },
    ])
    .toArray();
}

/** Returns recently enriched companies for dashboard freshness metrics. */
export async function countRecentlyEnriched(withinHours = 24): Promise<number> {
  const c = await col();
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000);
  return c.countDocuments({ lastEnrichedAt: { $gte: since } });
}

/** List all startup companies for batch enrichment (stale or never enriched). */
export async function listStartupCompaniesForEnrichment(
  freshnessHours = 24,
  limit = 500
): Promise<StartupCompanyDocument[]> {
  const c = await col();
  const cutoff = new Date(Date.now() - freshnessHours * 60 * 60 * 1000);
  return c
    .find({
      $or: [
        { lastEnrichedAt: { $lt: cutoff } },
        { lastEnrichedAt: { $exists: false } },
      ],
    })
    .sort({ lastEnrichedAt: 1 })
    .limit(limit)
    .toArray();
}
