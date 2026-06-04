import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";
import { upsertLead } from "../database/repositories/LeadRepository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CSV_COLUMNS = [
    // ── Identity ─────────────────────────────────────────────────────────────
    "companyName", "contactName", "designation", "ceoName", "cfoName", "ctoName", "cooName",
    // ── Contact ───────────────────────────────────────────────────────────────
    "email", "allEmails", "emailConfidenceScore", "emailSource",
    "phoneNumber", "phoneSource",
    // ── Web Presence ──────────────────────────────────────────────────────────
    "website", "companyProfileUrl", "websiteConfidence",
    "linkedinUrl", "linkedinProfileUrl", "linkedinCompanySlug", "linkedinCompanyId", "linkedinConfidence", "linkedinFollowers",
    // ── Company Info ──────────────────────────────────────────────────────────
    "sector", "industry", "companyType", "country", "fundingStage", "techStack", "techStackDetailed",
    "numberOfEmployees", "employeeSource",   // real headcount from API
    "employeeSize",                           // keyword-fallback size band
    // ── Signals ───────────────────────────────────────────────────────────────────
    "signalType", "fundingInfo", "newsHeadline", "hiringVelocity", "hiringTopRoles",
    "ctoLinkedInActive", "linkedinPainSignals", "lastPostDate", "postCount30Days",
    "recentFundingSignal", "isB2BSaaS",
    // ── ICP Score ─────────────────────────────────────────────────────────────
    "icpScore", "icpTier", "intents",
    // ── Job Data ──────────────────────────────────────────────────────────────
    "source", "jobLink", "jobTitle",
    "salary", "minSalary", "maxSalary", "currency",
    "location", "companyRating",
    "scrapeTimestamp",
];

/** Columns that must always be serialised as quoted strings (never as bare numbers). */
const FORCE_QUOTED_COLUMNS = new Set(["phoneNumber", "email"]);

function escapeCSV(value, colName = "") {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) {
        // Special handling for intents array: extract names from intent objects
        const serialized = value.map(item => {
            if (item && typeof item === "object") {
                // Intent object: {id, name, description, confidence}
                return item.name || item.id || JSON.stringify(item);
            }
            return String(item);
        }).join("; ");
        return escapeCSV(serialized, colName);
    }
    if (typeof value === "object") return escapeCSV(JSON.stringify(value), colName);
    const str = String(value);
    // For sensitive columns, always wrap in quotes so parsers treat them as text.
    const mustQuote = FORCE_QUOTED_COLUMNS.has(colName) || str.includes(",") || str.includes('"') || str.includes("\n");
    if (mustQuote) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}


let writeBuffer: string[] = [];

/** Flatten a lead so complex fields are pre-processed before CSV serialisation. */
function flattenLead(lead: Record<string, any>): Record<string, any> {
    const flat = { ...lead };

    // Flatten intents array → semicolon-separated intent names
    if (Array.isArray(flat.intents)) {
        flat.intents = flat.intents
            .map((i: any) => (i && typeof i === "object" ? i.name || i.id : String(i)))
            .filter(Boolean)
            .join("; ");
    }

    // Flatten hiringTopRoles / hiringVelocity if they are objects/arrays
    if (Array.isArray(flat.hiringTopRoles)) {
        flat.hiringTopRoles = flat.hiringTopRoles.join("; ");
    }

    return flat;
}

/**
 * Append a single lead to the CSV file AND upsert it into MongoDB.
 * @param lead       The enriched lead object.
 * @param filename   The CSV filename (without path).
 * @param scrapeRunId Optional MongoDB ObjectId of the current scrape run.
 */
export async function appendLeadToCSV(
    lead: Record<string, any>,
    filename: string,
    scrapeRunId?: ObjectId
): Promise<void> {
    const csvFilename = filename.replace(/\.json$/i, "") + (filename.endsWith(".csv") ? "" : ".csv");
    const outputPath = path.resolve(__dirname, "..", "..", "data", csvFilename);

    const flatLead = flattenLead(lead);
    const row = CSV_COLUMNS.map(col => escapeCSV(flatLead[col], col)).join(",");
    writeBuffer.push(row);

    // ── CSV write ─────────────────────────────────────────────────────────────
    try {
        if (!fs.existsSync(outputPath)) {
            fs.writeFileSync(outputPath, CSV_COLUMNS.join(",") + "\n", "utf-8");
        }
        if (writeBuffer.length > 0) {
            fs.appendFileSync(outputPath, writeBuffer.join("\n") + "\n", "utf-8");
            writeBuffer = [];
        }
    } catch (err: any) {
        if (err.code === "EBUSY") {
            console.warn(`\n⚠️  CSV Locked: ${path.basename(outputPath)} is open. Data buffered (${writeBuffer.length} leads).`);
        } else {
            console.error(`\n❌ Error appending to CSV:`, err.message);
        }
    }

    // ── MongoDB upsert (non-blocking on failure) ──────────────────────────────
    if (process.env.MONGODB_URI) {
        try {
            await upsertLead({ ...lead, scrapeRunId });
        } catch (err: any) {
            console.warn(`⚠️  MongoDB upsert skipped for "${lead.companyName}": ${err.message}`);
        }
    }
}

/**
 * Write all final leads to CSV and bulk-upsert them into MongoDB.
 * @param leads      Sorted, filtered lead array.
 * @param filename   The CSV filename (without path).
 * @param scrapeRunId Optional MongoDB ObjectId of the current scrape run.
 */
export async function saveResults(
    leads: Record<string, any>[],
    filename: string,
    scrapeRunId?: ObjectId
): Promise<string> {
    const csvFilename = filename.replace(/\.json$/i, "") + (filename.endsWith(".csv") ? "" : ".csv");
    const outputPath  = path.resolve(__dirname, "..", "..", "data", csvFilename);

    const header = CSV_COLUMNS.join(",");
    const rows   = leads.map(lead => {
        const flat = flattenLead(lead);
        return CSV_COLUMNS.map(col => escapeCSV(flat[col], col)).join(",");
    });

    fs.writeFileSync(outputPath, [header, ...rows].join("\n"), "utf-8");

    // ── MongoDB bulk upsert ───────────────────────────────────────────────────
    if (process.env.MONGODB_URI && leads.length > 0) {
        try {
            const leadsWithRun = leads.map(l => ({ ...l, scrapeRunId }));
            await Promise.all(leadsWithRun.map(l => upsertLead(l)));
            console.log(`   🗄️  MongoDB: ${leads.length} leads upserted.`);
        } catch (err: any) {
            console.warn(`   ⚠️  MongoDB bulk upsert failed: ${err.message}`);
        }
    }

    // ── Summary stats ─────────────────────────────────────────────────────────
    const hot  = leads.filter(l => l.icpTier === "Hot").length;
    const warm = leads.filter(l => l.icpTier === "Warm").length;
    const cold = leads.filter(l => l.icpTier === "Cold").length;

    const withRealEmail    = leads.filter(l => (l.emailConfidenceScore  || 0) >= 65).length;
    const withRealWebsite  = leads.filter(l => (l.websiteConfidence     || 0) >= 70).length;
    const withLinkedIn     = leads.filter(l => (l.linkedinConfidence    || 0) >= 70).length;
    const withPhone        = leads.filter(l => l.phoneNumber && l.phoneNumber.length > 5).length;
    const withEmployeeData = leads.filter(l => l.numberOfEmployees && l.numberOfEmployees.length > 0).length;
    const withNews         = leads.filter(l => l.newsHeadline && l.newsHeadline.length > 5).length;

    // Source breakdown for email and phone
    const emailSources = {};
    for (const l of leads) {
        const src = l.emailSource || "Unknown";
        emailSources[src] = (emailSources[src] || 0) + 1;
    }
    const phoneSources = {};
    for (const l of leads) {
        if (l.phoneNumber) {
            const src = l.phoneSource || "Unknown";
            phoneSources[src] = (phoneSources[src] || 0) + 1;
        }
    }

    console.log("\n📊 Pipeline Summary:");
    console.log(`   Total leads       : ${leads.length}`);
    console.log(`   🔥 Hot            : ${hot}`);
    console.log(`   🟡 Warm           : ${warm}`);
    console.log(`   ❄️  Cold           : ${cold}`);
    console.log("\n📈 Data Quality:");
    console.log(`   📧 Real emails    : ${withRealEmail}/${leads.length} (conf ≥65%)`);
    console.log(`      Sources        : ${JSON.stringify(emailSources)}`);
    console.log(`   📞 Phones found   : ${withPhone}/${leads.length}`);
    console.log(`      Sources        : ${JSON.stringify(phoneSources)}`);
    console.log(`   🌐 Real websites  : ${withRealWebsite}/${leads.length} (conf ≥70%)`);
    console.log(`   🔗 LinkedIn found : ${withLinkedIn}/${leads.length} (conf ≥70%)`);
    console.log(`   👥 Employee count : ${withEmployeeData}/${leads.length}`);
    console.log(`   📰 News/signals   : ${withNews}/${leads.length}`);

    return outputPath;
}

