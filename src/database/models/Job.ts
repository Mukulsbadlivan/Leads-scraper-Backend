import { ObjectId } from "mongodb";

/**
 * Represents a single job posting scraped from a job portal.
 * Maps to the `jobs` collection in MongoDB.
 */
export interface JobDocument {
  _id?: ObjectId;

  // ── Source ───────────────────────────────────────────────────────────────────
  source: string;               // "Indeed" | "Glassdoor" | "Upwork" | "Fallback"
  jobUrl: string;               // Unique dedup key
  jobTitle?: string;
  companyName?: string;

  // ── Location & Salary ────────────────────────────────────────────────────────
  location?: string;
  country?: string;
  state?: string;
  city?: string;
  sector?: string;
  salary?: string;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;

  // ── Portal-specific ──────────────────────────────────────────────────────────
  companyRating?: number;

  // ── Relations ────────────────────────────────────────────────────────────────
  companyId?: ObjectId;         // FK → companies._id (set after upsert)
  scrapeRunId?: ObjectId;       // FK → scrape_runs._id

  // ── Meta ─────────────────────────────────────────────────────────────────────
  scrapeTimestamp?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
