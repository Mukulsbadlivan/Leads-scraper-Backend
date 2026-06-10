/**
 * StartupLeadRepository.ts — CRUD for the `startup_leads` collection.
 * ISOLATED — does not touch the existing `leads` collection.
 */
import { Collection, ObjectId, Filter } from "mongodb";
import { getDb } from "../connection.ts";
import { StartupLeadDocument, GrowthTier } from "../models/StartupLead.ts";

const COLLECTION = "startup_leads";

async function col(): Promise<Collection<StartupLeadDocument>> {
  const db = await getDb();
  return db.collection<StartupLeadDocument>(COLLECTION);
}

export async function ensureStartupLeadIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ startupCompanyId: 1 }, { unique: true, background: true }),
    c.createIndex({ growthTier: 1 }, { background: true }),
    c.createIndex({ startupScore: -1 }, { background: true }),
    c.createIndex({ discoverySource: 1 }, { background: true }),
  ]);
}

/**
 * Upsert a startup lead by startupCompanyId (one lead per company).
 * Merges scores and signals on conflict.
 */
export async function upsertStartupLead(
  lead: Omit<StartupLeadDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();

  const existing = await c.findOne({ startupCompanyId: lead.startupCompanyId });

  if (existing) {
    const update: Partial<StartupLeadDocument> = { updatedAt: now };
    if (lead.jobLinks?.length) update.jobLinks = lead.jobLinks;
    if (lead.hiringRoles?.length) update.hiringRoles = lead.hiringRoles;
    if (lead.startupScore !== undefined) update.startupScore = lead.startupScore;
    if (lead.growthTier) update.growthTier = lead.growthTier;
    if (lead.hiringSignalStrength !== undefined) update.hiringSignalStrength = lead.hiringSignalStrength;
    if (lead.growthSignalStrength !== undefined) update.growthSignalStrength = lead.growthSignalStrength;
    if (lead.sourceTracking?.length) {
      update.sourceTracking = [
        ...(existing.sourceTracking ?? []),
        ...lead.sourceTracking,
      ];
    }
    await c.updateOne({ _id: existing._id }, { $set: update });
    return existing._id as ObjectId;
  }

  const result = await c.insertOne({
    ...lead,
    createdAt: now,
    updatedAt: now,
  } as StartupLeadDocument);
  return result.insertedId;
}

export async function countStartupLeads(
  filter: Filter<StartupLeadDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

export async function listStartupLeadsPaginated(
  page = 1,
  limit = 25,
  filter: Filter<StartupLeadDocument> = {}
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
        website: "$company.website",
        companyStage: "$company.companyStage",
        sector: "$company.sector",
        linkedinUrl: "$company.linkedinUrl",
      },
    },
    { $unset: "company" },
    { $sort: { startupScore: -1 } },
    { $skip: skip },
    { $limit: limit },
  ];

  return c.aggregate(pipeline).toArray();
}

export async function getStartupLeadsByTier(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c
    .aggregate<{ name: string; value: number }>([
      { $match: { growthTier: { $ne: null } } },
      { $group: { _id: "$growthTier", value: { $sum: 1 } } },
      { $project: { _id: 0, name: "$_id", value: 1 } },
      { $sort: { value: -1 } },
    ])
    .toArray();
}

export async function findStartupLeadByCompanyId(
  startupCompanyId: ObjectId
): Promise<StartupLeadDocument | null> {
  const c = await col();
  return c.findOne({ startupCompanyId });
}
