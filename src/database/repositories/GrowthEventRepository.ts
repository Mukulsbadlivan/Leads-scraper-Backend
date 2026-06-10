/**
 * GrowthEventRepository.ts — CRUD for the `growth_events` collection.
 */
import { Collection, ObjectId, Filter } from "mongodb";
import { getDb } from "../connection.ts";
import { GrowthEventDocument, GrowthEventType } from "../models/GrowthEvent.ts";

const COLLECTION = "growth_events";

async function col(): Promise<Collection<GrowthEventDocument>> {
  const db = await getDb();
  return db.collection<GrowthEventDocument>(COLLECTION);
}

export async function ensureGrowthEventIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ startupCompanyId: 1 }, { background: true }),
    c.createIndex({ newsId: 1 }, { background: true }),
    c.createIndex({ eventType: 1 }, { background: true }),
    c.createIndex({ announcedAt: -1 }, { background: true }),
    c.createIndex({ existingCompanyId: 1 }, { sparse: true, background: true }),
  ]);
}

export async function insertGrowthEvent(
  event: Omit<GrowthEventDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();
  const result = await c.insertOne({
    ...event,
    createdAt: now,
    updatedAt: now,
  } as GrowthEventDocument);
  return result.insertedId;
}

export async function countGrowthEvents(
  filter: Filter<GrowthEventDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

export async function listGrowthEventsPaginated(
  page = 1,
  limit = 25,
  filter: Filter<GrowthEventDocument> = {}
): Promise<GrowthEventDocument[]> {
  const c = await col();
  const skip = (page - 1) * limit;
  return c
    .find(filter)
    .sort({ announcedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

export async function findGrowthEventsByCompany(
  startupCompanyId: ObjectId
): Promise<GrowthEventDocument[]> {
  const c = await col();
  return c.find({ startupCompanyId }).sort({ announcedAt: -1 }).toArray();
}

export async function getGrowthEventTypeSummary(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c
    .aggregate<{ name: string; value: number }>([
      { $group: { _id: "$eventType", value: { $sum: 1 } } },
      { $project: { _id: 0, name: "$_id", value: 1 } },
      { $sort: { value: -1 } },
    ])
    .toArray();
}
