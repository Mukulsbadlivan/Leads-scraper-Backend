import { Router, Request, Response } from "express";
import { ObjectId } from "mongodb";
import {
  countCompanies,
  listCompaniesPaginated,
  findCompanyById,
  getCompaniesBySector
} from "../../database/repositories/CompanyRepository.ts";
import {
  countLeads,
  listLeadsPaginated,
  findLeadsByCompany,
  getLeadsByRegion,
  getLeadsBySector,
  getLeadsByTier,
  getLeadDiscoveryRates
} from "../../database/repositories/LeadRepository.ts";
import {
  countJobs,
  listJobsPaginated,
  findJobsByCompany,
  getJobsBySource,
  getJobsByLocation,
  getTopHiringCompanies,
  getJobsBySector
} from "../../database/repositories/JobRepository.ts";
import {
  countSignals,
  findSignalsByCompany
} from "../../database/repositories/SignalRepository.ts";
import {
  countActiveScrapeRuns,
  getDailyScrapeActivity,
  getScrapeSuccessMetrics,
  findScrapeRunById
} from "../../database/repositories/ScrapeRunRepository.ts";
import { countDuplicatesRemoved } from "../../database/repositories/DuplicateAuditRepository.ts";
import { logger } from "../../logging/logger.ts";

export const dataExplorerRouter = Router();

// ─── GET /api/dashboard ────────────────────────────────────────────────────────
dataExplorerRouter.get("/api/dashboard", async (req: Request, res: Response) => {
  try {
    const { country, state, city, sector } = req.query;

    const filter: any = {};
    if (country) filter.country = country;
    if (state) filter.state = state;
    if (city) filter.city = city;
    if (sector) filter.sector = sector;

    const [
      totalCompanies,
      totalLeads,
      totalJobs,
      totalSignals,
      activeScrapeRuns,
      companiesMerged,
      leadsMerged,
      duplicatesRemoved,
      leadsByRegion,
      leadsBySector,
      jobsBySource,
      dailyScrapeActivity
    ] = await Promise.all([
      countCompanies(filter),
      countLeads(filter),
      countJobs(filter),
      countSignals(filter),
      countActiveScrapeRuns(),
      countDuplicatesRemoved("companies"),
      countDuplicatesRemoved("leads"),
      countDuplicatesRemoved(),
      getLeadsByRegion(),
      getLeadsBySector(),
      getJobsBySource(),
      getDailyScrapeActivity(14)
    ]);

    await logger.apiRequest("GET", "/api/dashboard", 200).catch(() => {});

    return res.json({
      totalCompanies,
      totalLeads,
      totalJobs,
      totalSignals,
      activeScrapeRuns,
      companiesMerged,
      leadsMerged,
      duplicatesRemoved,
      leadsByRegion,
      leadsBySector,
      jobsBySource,
      dailyScrapeActivity
    });
  } catch (err: any) {
    console.error("[GET /api/dashboard] Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch dashboard metrics",
      message: err.message
    });
  }
});

// ─── GET /api/companies ────────────────────────────────────────────────────────
dataExplorerRouter.get("/api/companies", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 25;
    const { search, country, state, city, sector } = req.query;

    const filter: any = {};
    if (country) filter.country = country;
    if (state) filter.state = state;
    if (city) filter.city = city;
    if (sector) filter.sector = sector;
    if (search) {
      filter.$or = [
        { companyName: { $regex: search as string, $options: "i" } },
        { website: { $regex: search as string, $options: "i" } },
        { industry: { $regex: search as string, $options: "i" } }
      ];
    }

    const [total, data] = await Promise.all([
      countCompanies(filter),
      listCompaniesPaginated(page, limit, filter)
    ]);

    await logger.apiRequest("GET", "/api/companies", 200).catch(() => {});

    return res.json({
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err: any) {
    console.error("[GET /api/companies] Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch companies",
      message: err.message
    });
  }
});

// ─── GET /api/company/:id ──────────────────────────────────────────────────────
dataExplorerRouter.get("/api/company/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let companyObjectId: ObjectId;
    try {
      companyObjectId = new ObjectId(id as string);
    } catch {
      return res.status(400).json({ error: "Invalid company ID" });
    }

    const company = await findCompanyById(companyObjectId);
    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    const [jobs, leads, signals] = await Promise.all([
      findJobsByCompany(companyObjectId),
      findLeadsByCompany(companyObjectId),
      findSignalsByCompany(companyObjectId)
    ]);

    // Gather unique scrape run IDs from leads and jobs
    const runIds = new Set<string>();
    leads.forEach((l) => {
      if (l.scrapeRunId) runIds.add(l.scrapeRunId.toString());
    });
    jobs.forEach((j) => {
      if (j.scrapeRunId) runIds.add(j.scrapeRunId.toString());
    });

    const scrapeHistory = await Promise.all(
      Array.from(runIds).map(async (runIdStr) => {
        try {
          return await findScrapeRunById(new ObjectId(runIdStr));
        } catch {
          return null;
        }
      })
    );

    await logger.apiRequest("GET", `/api/company/${id}`, 200).catch(() => {});

    return res.json({
      ...company,
      jobs,
      leads,
      signals,
      scrapeHistory: scrapeHistory.filter(Boolean)
    });
  } catch (err: any) {
    console.error("[GET /api/company/:id] Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch company details",
      message: err.message
    });
  }
});

// ─── GET /api/leads ────────────────────────────────────────────────────────────
dataExplorerRouter.get("/api/leads", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 25;
    const { search, icpTier, country, state, city, sector } = req.query;

    const filter: any = {};
    if (country) filter.country = country;
    if (state) filter.state = state;
    if (city) filter.city = city;
    if (sector) filter.sector = sector;
    if (icpTier) filter.icpTier = icpTier;
    if (search) {
      filter.$or = [
        { companyName: { $regex: search as string, $options: "i" } },
        { contactName: { $regex: search as string, $options: "i" } },
        { designation: { $regex: search as string, $options: "i" } },
        { email: { $regex: search as string, $options: "i" } },
        { jobTitle: { $regex: search as string, $options: "i" } }
      ];
    }

    const [total, data] = await Promise.all([
      countLeads(filter),
      listLeadsPaginated(page, limit, filter)
    ]);

    await logger.apiRequest("GET", "/api/leads", 200).catch(() => {});

    return res.json({
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err: any) {
    console.error("[GET /api/leads] Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch leads",
      message: err.message
    });
  }
});

// ─── GET /api/jobs ─────────────────────────────────────────────────────────────
dataExplorerRouter.get("/api/jobs", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 25;
    const { search, source, country, state, city, sector } = req.query;

    const filter: any = {};
    if (country) filter.country = country;
    if (state) filter.state = state;
    if (city) filter.city = city;
    if (sector) filter.sector = sector;
    if (source) filter.source = { $regex: `^${source}$`, $options: "i" };
    if (search) {
      filter.$or = [
        { jobTitle: { $regex: search as string, $options: "i" } },
        { companyName: { $regex: search as string, $options: "i" } },
        { location: { $regex: search as string, $options: "i" } }
      ];
    }

    const [total, data] = await Promise.all([
      countJobs(filter),
      listJobsPaginated(page, limit, filter)
    ]);

    await logger.apiRequest("GET", "/api/jobs", 200).catch(() => {});

    return res.json({
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err: any) {
    console.error("[GET /api/jobs] Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch jobs",
      message: err.message
    });
  }
});

// ─── GET /api/reports ──────────────────────────────────────────────────────────
dataExplorerRouter.get("/api/reports", async (req: Request, res: Response) => {
  try {
    const [
      leadsBySector,
      jobsBySector,
      discoveryRates,
      jobsBySource,
      topHiringCompanies,
      companiesBySector,
      leadsByTier,
      jobsByLocation,
      scrapeSuccessMetrics
    ] = await Promise.all([
      getLeadsBySector(),
      getJobsBySector(),
      getLeadDiscoveryRates(),
      getJobsBySource(),
      getTopHiringCompanies(10),
      getCompaniesBySector(),
      getLeadsByTier(),
      getJobsByLocation(),
      getScrapeSuccessMetrics()
    ]);

    await logger.apiRequest("GET", "/api/reports", 200).catch(() => {});

    return res.json({
      sectorVolumes: {
        leads: leadsBySector,
        jobs: jobsBySector
      },
      discoveryRates,
      jobsBySource,
      topHiringCompanies,
      companiesBySector,
      leadsByTier,
      jobsByLocation,
      scrapeSuccessMetrics
    });
  } catch (err: any) {
    console.error("[GET /api/reports] Error:", err.message);
    return res.status(500).json({
      error: "Failed to generate reports",
      message: err.message
    });
  }
});
