/**
 * startupRouter.ts — Express Router for all /api/startup/* endpoints.
 *
 * NEW routes only. Does NOT modify any existing routes.
 * Mounted in server.ts with: app.use("/api/startup", startupRouter)
 */
import { Router, Request, Response } from "express";
import { ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { enqueueStartupJob } from "../../queue/startupQueue.ts";
import { startupQueue } from "../../queue/startupQueue.ts";
import {
  countStartupCompanies,
  listStartupCompaniesPaginated,
  findStartupCompanyById,
  getStartupCompaniesBySector,
  getStartupCompaniesByStage,
  countRecentlyEnriched,
} from "../../database/repositories/StartupCompanyRepository.ts";
import {
  countStartupExecutives,
  findExecutivesByCompany,
  listStartupExecutivesPaginated,
} from "../../database/repositories/StartupExecutiveRepository.ts";
import {
  countStartupLeads,
  listStartupLeadsPaginated,
  getStartupLeadsByTier,
} from "../../database/repositories/StartupLeadRepository.ts";
import {
  countCompanyNews,
  findNewsByCompany,
} from "../../database/repositories/CompanyNewsRepository.ts";
import { countFundingEvents } from "../../database/repositories/FundingEventRepository.ts";
import { countHiringEvents } from "../../database/repositories/HiringEventRepository.ts";
import { countGrowthEvents } from "../../database/repositories/GrowthEventRepository.ts";

export const startupRouter = Router();

// ─── POST /api/startup/discover ───────────────────────────────────────────────
startupRouter.post("/discover", async (req: Request, res: Response) => {
  try {
    const { sources, filters, enrichOptions } = req.body ?? {};
    const jobRunId = uuidv4();

    const bullJobId = await enqueueStartupJob({
      jobRunId,
      sources: sources ?? ["existing_companies", "yc", "wellfound", "rss"],
      sectors: filters?.sectors,
      stages: filters?.stages,
      maxCompanies: filters?.maxCompanies ?? 200,
      enrichExecutives: enrichOptions?.enrichExecutives !== false,
      enrichNews: enrichOptions?.enrichNews ?? true,
    });

    return res.status(200).json({
      success: true,
      jobId: `startup:${jobRunId}`,
      queueJobId: bullJobId,
      message: "Startup discovery job queued",
    });
  } catch (err: any) {
    console.error("[POST /api/startup/discover]", err.message);
    return res.status(500).json({ error: "Failed to enqueue startup discovery job", message: err.message });
  }
});

// ─── GET /api/startup/status/:jobId ───────────────────────────────────────────
startupRouter.get("/status/:jobId", async (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const job = await startupQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    const state = await job.getState();
    const progress = job.progress as any;

    return res.json({
      jobId,
      status: state,
      progress: typeof progress === "number" ? progress : progress?.progress ?? 0,
      currentStage: progress?.stage ?? "Unknown",
      companiesDiscovered: progress?.companiesDiscovered ?? 0,
      companiesEnriched: progress?.companiesEnriched ?? 0,
      executivesFound: progress?.executivesFound ?? 0,
      startedAt: job.processedOn ? new Date(job.processedOn) : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch job status", message: err.message });
  }
});

// ─── GET /api/startup/dashboard ───────────────────────────────────────────────
startupRouter.get("/dashboard", async (_req: Request, res: Response) => {
  try {
    const [
      totalStartups,
      totalExecutives,
      totalStartupLeads,
      tierCounts,
      byStage,
      bySector,
      ycBacked,
      recentlyEnriched,
      totalFundingEvents,
      totalHiringEvents,
      totalGrowthEvents,
    ] = await Promise.all([
      countStartupCompanies(),
      countStartupExecutives(),
      countStartupLeads(),
      getStartupLeadsByTier(),
      getStartupCompaniesByStage(),
      getStartupCompaniesBySector(),
      countStartupCompanies({ isYCBacked: true }),
      countRecentlyEnriched(24),
      countFundingEvents(),
      countHiringEvents(),
      countGrowthEvents(),
    ]);

    const tierMap = Object.fromEntries(tierCounts.map((t) => [t.name, t.value]));

    return res.json({
      totalStartups,
      totalExecutives,
      totalStartupLeads,
      hotLeads: tierMap["Hot"] ?? 0,
      warmLeads: tierMap["Warm"] ?? 0,
      coldLeads: tierMap["Cold"] ?? 0,
      byStage,
      bySector,
      ycBacked,
      recentlyEnriched,
      totalFundingEvents,
      totalHiringEvents,
      totalGrowthEvents,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch startup dashboard", message: err.message });
  }
});

// ─── GET /api/startup/companies ───────────────────────────────────────────────
startupRouter.get("/companies", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const search = req.query.search as string | undefined;
    const sector = req.query.sector as string | undefined;
    const stage = req.query.stage as string | undefined;
    const country = req.query.country as string | undefined;
    const isYCBacked = req.query.isYCBacked === "true" ? true : req.query.isYCBacked === "false" ? false : undefined;
    const sortBy = (req.query.sortBy as string) || "dataQualityScore";
    const sortOrder: 1 | -1 = req.query.sortOrder === "asc" ? 1 : -1;

    const filter: any = {};
    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { website: { $regex: search, $options: "i" } },
      ];
    }
    if (sector) filter.sector = { $regex: sector, $options: "i" };
    if (stage) filter.companyStage = stage;
    if (country) filter.country = { $regex: country, $options: "i" };
    if (isYCBacked !== undefined) filter.isYCBacked = isYCBacked;

    const [data, total] = await Promise.all([
      listStartupCompaniesPaginated(page, limit, filter, sortBy, sortOrder),
      countStartupCompanies(filter),
    ]);

    return res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list startup companies", message: err.message });
  }
});

// ─── GET /api/startup/company/:id ─────────────────────────────────────────────
startupRouter.get("/company/:id", async (req: Request, res: Response) => {
  try {
    let oid: ObjectId;
    try { oid = new ObjectId(req.params.id as string); }
    catch { return res.status(400).json({ error: "Invalid company ID" }); }

    const company = await findStartupCompanyById(oid);
    if (!company) return res.status(404).json({ error: "Startup company not found" });

    const [executives, recentNews] = await Promise.all([
      findExecutivesByCompany(oid),
      findNewsByCompany(oid, 10),
    ]);

    return res.json({ ...company, executives, recentNews });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch startup company", message: err.message });
  }
});

// ─── GET /api/startup/leads ───────────────────────────────────────────────────
startupRouter.get("/leads", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const growthTier = req.query.growthTier as string | undefined;
    const search = req.query.search as string | undefined;
    const discoverySource = req.query.discoverySource as string | undefined;

    const filter: any = {};
    if (growthTier) filter.growthTier = growthTier;
    if (discoverySource) filter.discoverySource = discoverySource;

    const [data, total] = await Promise.all([
      listStartupLeadsPaginated(page, limit, filter),
      countStartupLeads(filter),
    ]);

    return res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list startup leads", message: err.message });
  }
});

// ─── GET /api/startup/executives ──────────────────────────────────────────────
startupRouter.get("/executives", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const role = req.query.role as string | undefined;
    const startupCompanyId = req.query.startupCompanyId as string | undefined;

    const filter: any = {};
    if (role) filter.role = role;
    if (startupCompanyId) {
      try { filter.startupCompanyId = new ObjectId(startupCompanyId); } catch { /* ignore */ }
    }

    const [data, total] = await Promise.all([
      listStartupExecutivesPaginated(page, limit, filter),
      countStartupExecutives(filter),
    ]);

    return res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list executives", message: err.message });
  }
});

// ─── GET /api/startup/queue/metrics ───────────────────────────────────────────
startupRouter.get("/queue/metrics", async (_req: Request, res: Response) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      startupQueue.getWaitingCount(),
      startupQueue.getActiveCount(),
      startupQueue.getCompletedCount(),
      startupQueue.getFailedCount(),
      startupQueue.getDelayedCount(),
    ]);

    return res.json({
      queueName: "startup-intelligence-jobs",
      waiting,
      active,
      completed,
      failed,
      delayed,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch queue metrics", message: err.message });
  }
});
