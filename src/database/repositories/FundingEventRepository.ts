/**
 * FundingEventRepository.ts — CRUD for the `funding_events` collection.
 */
import { Collection, ObjectId, Filter } from "mongodb";
import { getDb } from "../connection.ts";
import { FundingEventDocument, FundingRound } from "../models/FundingEvent.ts";

const COLLECTION = "funding_events";

async function col(): Promise<Collection<FundingEventDocument>> {
  const db = await getDb();
  return db.collection<FundingEventDocument>(COLLECTION);
}

export async function ensureFundingEventIndexes(): Promise<void> {
  const c = await col();
  await Promise.all([
    c.createIndex({ startupCompanyId: 1 }, { background: true }),
    c.createIndex({ newsId: 1 }, { background: true }),
    c.createIndex({ round: 1 }, { background: true }),
    c.createIndex({ announcedAt: -1 }, { background: true }),
    c.createIndex({ existingCompanyId: 1 }, { sparse: true, background: true }),
  ]);
}

export async function insertFundingEvent(
  event: Omit<FundingEventDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();
  const result = await c.insertOne({
    ...event,
    createdAt: now,
    updatedAt: now,
  } as FundingEventDocument);
  return result.insertedId;
}

export async function countFundingEvents(
  filter: Filter<FundingEventDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

export async function listFundingEventsPaginated(
  page = 1,
  limit = 25,
  filter: Filter<FundingEventDocument> = {}
): Promise<FundingEventDocument[]> {
  const c = await col();
  const skip = (page - 1) * limit;
  return c
    .find(filter)
    .sort({ announcedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

export async function findFundingEventsByCompany(
  startupCompanyId: ObjectId
): Promise<FundingEventDocument[]> {
  const c = await col();
  return c.find({ startupCompanyId }).sort({ announcedAt: -1 }).toArray();
}

export async function getFundingRoundSummary(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c
    .aggregate<{ name: string; value: number }>([
      { $group: { _id: "$round", value: { $sum: 1 } } },
      { $project: { _id: 0, name: "$_id", value: 1 } },
      { $sort: { value: -1 } },
    ])
    .toArray();
}

export async function getTotalFundingAmount(): Promise<number> {
  const c = await col();
  const result = await c
    .aggregate<{ total: number }>([
      { $match: { amount: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ])
    .toArray();
  return result[0]?.total ?? 0;
}
