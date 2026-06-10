/**
 * StartupExecutiveRepository.ts — CRUD for the `startup_executives` collection.
 * ISOLATED — does not touch the existing `leads` collection.
 */
import { Collection, ObjectId, Filter } from "mongodb";
import { getDb } from "../connection.ts";
import { StartupExecutiveDocument, ExecutiveRole } from "../models/StartupExecutive.ts";

const COLLECTION = "startup_executives";

async function col(): Promise<Collection<StartupExecutiveDocument>> {
  const db = await getDb();
  return db.collection<StartupExecutiveDocument>(COLLECTION);
}

export async function ensureStartupExecutiveIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ startupCompanyId: 1 }, { background: true }),
    c.createIndex({ linkedinUrl: 1 }, { sparse: true, background: true }),
    c.createIndex({ role: 1 }, { background: true }),
    c.createIndex(
      { startupCompanyId: 1, role: 1 },
      { background: true }
    ),
  ]);
}

/**
 * Upsert an executive by (startupCompanyId + role).
 * Only one executive per role per company is stored.
 */
export async function upsertStartupExecutive(
  exec: Omit<StartupExecutiveDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();

  const existing = await c.findOne({
    startupCompanyId: exec.startupCompanyId,
    role: exec.role,
  });

  if (existing) {
    const update: Partial<StartupExecutiveDocument> = { updatedAt: now };
    if (exec.name) update.name = exec.name;
    if (exec.title) update.title = exec.title;
    if (exec.linkedinUrl) update.linkedinUrl = exec.linkedinUrl;
    if (exec.linkedinSlug) update.linkedinSlug = exec.linkedinSlug;
    if (exec.email) update.email = exec.email;
    if (exec.sourceTracking?.length) update.sourceTracking = exec.sourceTracking;
    if (exec.existingCompanyId) update.existingCompanyId = exec.existingCompanyId;

    await c.updateOne({ _id: existing._id }, { $set: update });
    return existing._id as ObjectId;
  }

  const result = await c.insertOne({
    ...exec,
    createdAt: now,
    updatedAt: now,
  } as StartupExecutiveDocument);
  return result.insertedId;
}

export async function findExecutivesByCompany(
  startupCompanyId: ObjectId
): Promise<StartupExecutiveDocument[]> {
  const c = await col();
  return c.find({ startupCompanyId }).sort({ role: 1 }).toArray();
}

export async function findExecutiveByRole(
  startupCompanyId: ObjectId,
  role: ExecutiveRole
): Promise<StartupExecutiveDocument | null> {
  const c = await col();
  return c.findOne({ startupCompanyId, role });
}

export async function countStartupExecutives(
  filter: Filter<StartupExecutiveDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

export async function listStartupExecutivesPaginated(
  page = 1,
  limit = 25,
  filter: Filter<StartupExecutiveDocument> = {}
): Promise<any[]> {
  const c = await col();
  const skip = (page - 1) * limit;

  const pipeline = [
    { $match: filter },
    {
      $lookup: {
        from: "startup_companies",
        localField: "startupCompanyId",
        foreignField: "_id",
        as: "company",
      },
    },
    { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        companyName: "$company.companyName",
        companyWebsite: "$company.website",
      },
    },
    { $unset: "company" },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
  ];

  return c.aggregate(pipeline).toArray();
}
