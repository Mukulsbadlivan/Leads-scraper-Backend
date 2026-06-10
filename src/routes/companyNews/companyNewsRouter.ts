/**
 * companyNewsRouter.ts — Express Router for all /api/company-news/* endpoints.
 *
 * NEW routes only. Does NOT modify any existing routes.
 * Mounted in server.ts with: app.use("/api/company-news", companyNewsRouter)
 */
import { Router, Request, Response } from "express";
import { ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { enqueueCompanyNewsJob } from "../../queue/companyNewsQueue.ts";
import { companyNewsQueue } from "../../queue/companyNewsQueue.ts";
import {
  countCompanyNews,
  listCompanyNewsPaginated,
  findNewsByCompany,
} from "../../database/repositories/CompanyNewsRepository.ts";
import {
  countFundingEvents,
  listFundingEventsPaginated,
  findFundingEventsByCompany,
  getFundingRoundSummary,
  getTotalFundingAmount,
} from "../../database/repositories/FundingEventRepository.ts";
import {
  countHiringEvents,
  listHiringEventsPaginated,
  findHiringEventsByCompany,
  getHiringEventTypeSummary,
} from "../../database/repositories/HiringEventRepository.ts";
import {
  countGrowthEvents,
  listGrowthEventsPaginated,
  findGrowthEventsByCompany,
  getGrowthEventTypeSummary,
} from "../../database/repositories/GrowthEventRepository.ts";

export const companyNewsRouter = Router();

// ─── POST /api/company-news/collect ───────────────────────────────────────────
companyNewsRouter.post("/collect", async (req: Request, res: Response) => {
  try {
    const { sources, companyIds, lookbackDays } = req.body ?? {};
    const jobRunId = uuidv4();

    const bullJobId = await enqueueCompanyNewsJob({
      jobRunId,
      sources: sources ?? ["rss", "google_news", "newsapi"],
      companyIds: companyIds ?? [],
      lookbackDays: lookbackDays ?? 7,
    });

    return res.status(200).json({
      success: true,
      jobId: `news:${jobRunId}`,
      queueJobId: bullJobId,
      message: "News collection job queued",
    });
  } catch (err: any) {
    console.error("[POST /api/company-news/collect]", err.message);
    return res.status(500).json({ error: "Failed to enqueue news collection job", message: err.message });
  }
});

// ─── GET /api/company-news/status/:jobId ──────────────────────────────────────
companyNewsRouter.get("/status/:jobId", async (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const job = await companyNewsQueue.getJob(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const state = await job.getState();
    const progress = job.progress as any;

    return res.json({
      jobId: req.params.jobId,
      status: state,
      currentStage: progress?.stage ?? "Unknown",
      count: progress?.count ?? 0,
      startedAt: job.processedOn ? new Date(job.processedOn) : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch job status", message: err.message });
  }
});

// ─── GET /api/company-news/articles ───────────────────────────────────────────
companyNewsRouter.get("/articles", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const eventType = req.query.eventType as string | undefined;
    const search = req.query.search as string | undefined;
    const startupCompanyId = req.query.startupCompanyId as string | undefined;
    const fromDate = req.query.fromDate as string | undefined;
    const toDate = req.query.toDate as string | undefined;

    const filter: any = {};
    if (eventType) filter.eventType = eventType;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { companyName: { $regex: search, $options: "i" } },
      ];
    }
    if (startupCompanyId) {
      try { filter.startupCompanyId = new ObjectId(startupCompanyId); } catch { /* ignore */ }
    }
    if (fromDate || toDate) {
      filter.publishedAt = {};
      if (fromDate) filter.publishedAt.$gte = new Date(fromDate);
      if (toDate) filter.publishedAt.$lte = new Date(toDate);
    }

    const [data, total] = await Promise.all([
      listCompanyNewsPaginated(page, limit, filter),
      countCompanyNews(filter),
    ]);

    return res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list news articles", message: err.message });
  }
});

// ─── GET /api/company-news/funding ────────────────────────────────────────────
companyNewsRouter.get("/funding", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const round = req.query.round as string | undefined;
    const startupCompanyId = req.query.startupCompanyId as string | undefined;
    const fromDate = req.query.fromDate as string | undefined;
    const toDate = req.query.toDate as string | undefined;

    const filter: any = {};
    if (round) filter.round = round;
    if (startupCompanyId) {
      try { filter.startupCompanyId = new ObjectId(startupCompanyId); } catch { /* ignore */ }
    }
    if (fromDate || toDate) {
      filter.announcedAt = {};
      if (fromDate) filter.announcedAt.$gte = new Date(fromDate);
      if (toDate) filter.announcedAt.$lte = new Date(toDate);
    }

    const [data, total, roundSummary, totalCapital] = await Promise.all([
      listFundingEventsPaginated(page, limit, filter),
      countFundingEvents(filter),
      getFundingRoundSummary(),
      getTotalFundingAmount(),
    ]);

    return res.json({
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      summary: { roundBreakdown: roundSummary, totalCapitalRaised: totalCapital },
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list funding events", message: err.message });
  }
});

// ─── GET /api/company-news/hiring ─────────────────────────────────────────────
companyNewsRouter.get("/hiring", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const eventType = req.query.eventType as string | undefined;
    const startupCompanyId = req.query.startupCompanyId as string | undefined;
    const fromDate = req.query.fromDate as string | undefined;
    const toDate = req.query.toDate as string | undefined;

    const filter: any = {};
    if (eventType) filter.eventType = eventType;
    if (startupCompanyId) {
      try { filter.startupCompanyId = new ObjectId(startupCompanyId); } catch { /* ignore */ }
    }
    if (fromDate || toDate) {
      filter.announcedAt = {};
      if (fromDate) filter.announcedAt.$gte = new Date(fromDate);
      if (toDate) filter.announcedAt.$lte = new Date(toDate);
    }

    const [data, total, typeSummary] = await Promise.all([
      listHiringEventsPaginated(page, limit, filter),
      countHiringEvents(filter),
      getHiringEventTypeSummary(),
    ]);

    return res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit), summary: { typeBreakdown: typeSummary } });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list hiring events", message: err.message });
  }
});

// ─── GET /api/company-news/growth ─────────────────────────────────────────────
companyNewsRouter.get("/growth", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string ?? "1", 10);
    const limit = Math.min(parseInt(req.query.limit as string ?? "25", 10), 100);
    const eventType = req.query.eventType as string | undefined;
    const startupCompanyId = req.query.startupCompanyId as string | undefined;
    const fromDate = req.query.fromDate as string | undefined;
    const toDate = req.query.toDate as string | undefined;

    const filter: any = {};
    if (eventType) filter.eventType = eventType;
    if (startupCompanyId) {
      try { filter.startupCompanyId = new ObjectId(startupCompanyId); } catch { /* ignore */ }
    }
    if (fromDate || toDate) {
      filter.announcedAt = {};
      if (fromDate) filter.announcedAt.$gte = new Date(fromDate);
      if (toDate) filter.announcedAt.$lte = new Date(toDate);
    }

    const [data, total, typeSummary] = await Promise.all([
      listGrowthEventsPaginated(page, limit, filter),
      countGrowthEvents(filter),
      getGrowthEventTypeSummary(),
    ]);

    return res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit), summary: { typeBreakdown: typeSummary } });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to list growth events", message: err.message });
  }
});

// ─── GET /api/company-news/company/:companyId ─────────────────────────────────
companyNewsRouter.get("/company/:companyId", async (req: Request, res: Response) => {
  try {
    let oid: ObjectId;
    try { oid = new ObjectId(req.params.companyId as string); }
    catch { return res.status(400).json({ error: "Invalid company ID" }); }

    const [news, funding, hiring, growth] = await Promise.all([
      findNewsByCompany(oid, 50),
      findFundingEventsByCompany(oid),
      findHiringEventsByCompany(oid),
      findGrowthEventsByCompany(oid),
    ]);

    const companyName = news[0]?.companyName ?? funding[0]?.companyName ?? hiring[0]?.companyName ?? growth[0]?.companyName ?? "";

    return res.json({ companyName, news, funding, hiring, growth });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to fetch company news", message: err.message });
  }
});

// ─── GET /api/company-news/queue/metrics ──────────────────────────────────────
companyNewsRouter.get("/queue/metrics", async (_req: Request, res: Response) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      companyNewsQueue.getWaitingCount(),
      companyNewsQueue.getActiveCount(),
      companyNewsQueue.getCompletedCount(),
      companyNewsQueue.getFailedCount(),
      companyNewsQueue.getDelayedCount(),
    ]);

    return res.json({
      queueName: "company-news-jobs",
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
