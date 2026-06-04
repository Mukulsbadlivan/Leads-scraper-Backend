/**
 * testDedup.ts — Executable test script to verify all phases of the
 * Data Quality & Deduplication Layer.
 *
 * Run with: npx tsx -r dotenv/config src/scratch/testDedup.ts
 */

import "dotenv/config";
import { initDb } from "../database/initDb.ts";
import { getDb, closeConnection } from "../database/mongodb.ts";
import { normalizeCompanyName } from "../intelligence/companyNormalizer.ts";
import { upsertCompany, findCompanyById } from "../database/repositories/CompanyRepository.ts";
import { upsertLead, findLeadById } from "../database/repositories/LeadRepository.ts";
import { runDeduplication } from "../intelligence/backgroundDeduplicator.ts";
import { countDuplicatesRemoved } from "../database/repositories/DuplicateAuditRepository.ts";

async function runTests() {
  console.log("=========================================");
  console.log("  Running Deduplication Layer Tests");
  console.log("=========================================");

  // Initialize DB
  await initDb();
  const db = await getDb();

  // Clear existing duplicate audit logs for testing clean slate
  await db.collection("duplicate_audit").deleteMany({});

  // ─── Test 1: Company Normalization ──────────────────────────────────────────
  console.log("\n🧪 Test 1: Company Name Normalization...");
  const testNames = [
    { input: "Google LLC", expected: "google" },
    { input: "Google Inc.", expected: "google" },
    { input: "Google Limited", expected: "google" },
    { input: "Google Pvt. Ltd.", expected: "google" },
    { input: "Google, Inc.", expected: "google" },
    { input: "Google  LLC ", expected: "google" }
  ];

  for (const t of testNames) {
    const normalized = normalizeCompanyName(t.input);
    if (normalized !== t.expected) {
      throw new Error(`Normalization failed for "${t.input}": expected "${t.expected}", got "${normalized}"`);
    }
  }
  console.log("  ✓ Suffixes, casing, punctuation, and spacing normalized correctly!");

  // ─── Test 2: Real-time Company Upsert & Merging ────────────────────────────
  console.log("\n🧪 Test 2: Real-time Company Upsert & Merging...");
  
  // Clean up any test companies
  await db.collection("companies").deleteMany({
    $or: [
      { normalizedName: "test corporation" },
      { normalizedName: "test" },
      { website: "testcorp.com" }
    ]
  });

  // Insert company 1 (primarily has website info)
  const id1 = await upsertCompany({
    companyName: "Test Corporation LLC",
    website: "testcorp.com",
    sector: "Technology"
  });

  // Insert company 2 (duplicate by normalized name, adds linkedinUrl and fundingInfo)
  const id2 = await upsertCompany({
    companyName: "Test Corporation Inc",
    linkedinUrl: "https://linkedin.com/company/testcorp",
    fundingInfo: "$10M Series A"
  });

  // They should have resolved to the same MongoDB ID
  if (id1.toString() !== id2.toString()) {
    throw new Error(`Duplicate company records created! IDs are different: ${id1} vs ${id2}`);
  }

  const mergedCompany = await findCompanyById(id1);
  if (!mergedCompany) throw new Error("Merged company not found!");

  // Assert fields merged correctly
  if (mergedCompany.website !== "testcorp.com") {
    throw new Error(`Website not preserved! Got: ${mergedCompany.website}`);
  }
  if (mergedCompany.linkedinUrl !== "https://linkedin.com/company/testcorp") {
    throw new Error(`LinkedIn URL not merged! Got: ${mergedCompany.linkedinUrl}`);
  }
  if (mergedCompany.fundingInfo !== "$10M Series A") {
    throw new Error(`Funding info not merged! Got: ${mergedCompany.fundingInfo}`);
  }
  if (mergedCompany.normalizedName !== "test corporation") {
    throw new Error(`Normalized name incorrect! Got: ${mergedCompany.normalizedName}`);
  }

  console.log("  ✓ Company duplicates merged on-the-fly and fields completed!");

  // ─── Test 3: Real-time Lead Upsert & Merging ───────────────────────────────
  console.log("\n🧪 Test 3: Real-time Lead Upsert & Merging...");

  // Clean up any test leads
  await db.collection("leads").deleteMany({
    $or: [
      { contactName: "Test Contact" },
      { email: "contact@testcorp.com" }
    ]
  });

  // Insert Lead 1 (via company Name)
  const leadId1 = await upsertLead({
    contactName: "Test Contact",
    companyName: "Test Corporation LLC",
    email: "contact@testcorp.com",
    designation: "CTO",
    icpScore: 80,
    icpTier: "Hot"
  });

  // Insert Lead 2 (duplicate by email, adds linkedin url and jobTitle)
  const leadId2 = await upsertLead({
    contactName: "Test Contact",
    companyName: "Test Corporation Inc",
    email: "contact@testcorp.com",
    linkedinProfileUrl: "https://linkedin.com/in/testcontact",
    jobTitle: "Chief Technology Officer"
  });

  // Should resolve to same ID
  if (leadId1.toString() !== leadId2.toString()) {
    throw new Error(`Duplicate leads created! IDs are different: ${leadId1} vs ${leadId2}`);
  }

  const mergedLead = await findLeadById(leadId1);
  if (!mergedLead) throw new Error("Merged lead not found!");

  // Assert fields merged correctly
  if (mergedLead.email !== "contact@testcorp.com") {
    throw new Error(`Email mismatch! Got: ${mergedLead.email}`);
  }
  if (mergedLead.linkedinProfileUrl !== "https://linkedin.com/in/testcontact") {
    throw new Error(`LinkedIn profile URL not merged! Got: ${mergedLead.linkedinProfileUrl}`);
  }
  if (mergedLead.jobTitle !== "Chief Technology Officer") {
    throw new Error(`Job title not merged! Got: ${mergedLead.jobTitle}`);
  }
  if (mergedLead.designation !== "CTO") {
    throw new Error(`Designation not preserved! Got: ${mergedLead.designation}`);
  }

  console.log("  ✓ Lead duplicates merged on-the-fly and fields completed!");

  // ─── Test 4: Background Deduplication & Relational Cascading ───────────────
  console.log("\n🧪 Test 4: Background Deduplication & Cascading...");

  // Force insert actual duplicate companies directly to MongoDB bypassing upsert
  await db.collection("companies").deleteMany({
    companyName: { $in: ["Batch Company A", "Batch Company B"] }
  });
  await db.collection("leads").deleteMany({
    contactName: { $in: ["Batch Lead 1", "Batch Lead 2"] }
  });
  await db.collection("signals").deleteMany({
    headline: { $in: ["Batch Signal 1", "Batch Signal 2"] }
  });

  const rawComp1 = await db.collection("companies").insertOne({
    companyName: "Batch Company A",
    normalizedName: "batch company",
    website: "batch.com"
  });
  const rawComp2 = await db.collection("companies").insertOne({
    companyName: "Batch Company B",
    normalizedName: "batch company",
    linkedinUrl: "https://linkedin.com/company/batch"
  });

  // Insert lead and signal pointing to company 2 (which will be deleted)
  const rawLead = await db.collection("leads").insertOne({
    contactName: "Batch Lead 1",
    companyName: "Batch Company B",
    companyId: rawComp2.insertedId,
    email: "lead@batch.com"
  });

  const rawSignal = await db.collection("signals").insertOne({
    category: "funding",
    headline: "Batch Signal 1",
    companyId: rawComp2.insertedId,
    leadId: rawLead.insertedId
  });

  // Run background batch deduplication
  const summary = await runDeduplication();

  if (summary.companiesMerged === 0) {
    throw new Error("Batch deduplication failed to find and merge duplicate companies!");
  }

  // Verify company 2 deleted and company 1 updated
  const survivingComp = await db.collection("companies").findOne({ _id: rawComp1.insertedId });
  const deletedComp = await db.collection("companies").findOne({ _id: rawComp2.insertedId });

  if (!survivingComp) throw new Error("Surviving company not found!");
  if (deletedComp) throw new Error("Deleted duplicate company still exists in DB!");

  // Assert fields merged in surviving company
  if (survivingComp.linkedinUrl !== "https://linkedin.com/company/batch") {
    throw new Error(`LinkedIn URL not merged in batch deduplication! Got: ${survivingComp.linkedinUrl}`);
  }

  // Assert cascade updates: lead and signal should now point to rawComp1.insertedId
  const updatedLead = await db.collection("leads").findOne({ _id: rawLead.insertedId });
  const updatedSignal = await db.collection("signals").findOne({ _id: rawSignal.insertedId });

  if (!updatedLead || updatedLead.companyId?.toString() !== rawComp1.insertedId.toString()) {
    throw new Error(`Lead companyId cascade failed! Still points to deleted company or missing.`);
  }
  if (!updatedSignal || updatedSignal.companyId?.toString() !== rawComp1.insertedId.toString()) {
    throw new Error(`Signal companyId cascade failed! Still points to deleted company or missing.`);
  }

  console.log("  ✓ Background batch deduplication successfully merged records and cascaded foreign keys!");

  // ─── Test 5: Audit Log Validation ──────────────────────────────────────────
  console.log("\n🧪 Test 5: Audit Log Validation...");
  const compAudits = await countDuplicatesRemoved("companies");
  const leadAudits = await countDuplicatesRemoved("leads");
  const totalAudits = await countDuplicatesRemoved();

  if (compAudits === 0 || leadAudits === 0 || totalAudits === 0) {
    throw new Error(`Audit logs not written! Companies: ${compAudits}, Leads: ${leadAudits}, Total: ${totalAudits}`);
  }
  console.log(`  ✓ Duplicate audit trail recorded successfully! (Total removed: ${totalAudits})`);

  console.log("\n=========================================");
  console.log("  🎉 All Deduplication Tests Passed!");
  console.log("=========================================");
}

runTests()
  .then(async () => {
    await closeConnection();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n❌ Test Suite Failed:", err);
    await closeConnection();
    process.exit(1);
  });
