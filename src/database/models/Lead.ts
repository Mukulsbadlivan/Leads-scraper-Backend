import { ObjectId } from "mongodb";

/** A single detected buying intent signal. */
export interface Intent {
  id: string;
  name: string;
  description?: string;
  confidence?: number;
}

/**
 * Fully enriched and scored lead ready for outreach.
 * Maps to the `leads` collection in MongoDB.
 */
export interface LeadDocument {
  _id?: ObjectId;

  // ── Identity ─────────────────────────────────────────────────────────────────
  companyName?: string;
  contactName?: string;
  designation?: string;
  ceoName?: string;
  cfoName?: string;
  ctoName?: string;
  cooName?: string;

  // ── Contact ──────────────────────────────────────────────────────────────────
  email?: string;
  allEmails?: string[];
  emailConfidenceScore?: number;
  emailSource?: string;
  phoneNumber?: string;
  phoneSource?: string;

  // ── Web Presence ─────────────────────────────────────────────────────────────
  website?: string;
  companyProfileUrl?: string;
  websiteConfidence?: number;
  linkedinUrl?: string;
  linkedinProfileUrl?: string;
  linkedinCompanySlug?: string;
  linkedinCompanyId?: string;
  linkedinConfidence?: number;
  linkedinFollowers?: number;

  // ── Company Info ─────────────────────────────────────────────────────────────
  sector?: string;
  industry?: string;
  companyType?: string;
  country?: string;
  state?: string;
  city?: string;
  fundingStage?: string;
  techStack?: string;
  techStackDetailed?: Record<string, unknown> | string;
  numberOfEmployees?: string;
  employeeSource?: string;
  employeeSize?: string;

  // ── Signals ──────────────────────────────────────────────────────────────────
  signalType?: string;
  fundingInfo?: string;
  newsHeadline?: string;
  hiringVelocity?: {
    last30days: number;
    last60days: number;
    trend: string;
    topRoles: string[];
  };
  hiringTopRoles?: string[];
  ctoLinkedInActive?: boolean;
  linkedinPainSignals?: string;
  lastPostDate?: string;
  postCount30Days?: number;
  recentFundingSignal?: boolean;
  isB2BSaaS?: boolean;

  // ── ICP Score ────────────────────────────────────────────────────────────────
  icpScore?: number;
  icpTier?: "Hot" | "Warm" | "Cold";
  intents?: Intent[];

  // ── Job Data (from triggering job post) ─────────────────────────────────────
  source?: string;
  jobLink?: string;
  jobTitle?: string;
  salary?: string;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  location?: string;
  companyRating?: number;

  // ── Relations ────────────────────────────────────────────────────────────────
  companyId?: ObjectId;         // FK → companies._id
  scrapeRunId?: ObjectId;       // FK → scrape_runs._id

  // ── Meta ─────────────────────────────────────────────────────────────────────
  scrapeTimestamp?: string | Date;
  createdAt?: Date;
  updatedAt?: Date;
}
