/**
 * scraper.ts — Express routes for the scraper API.
 *
 * Routes:
 *   POST /api/scraper/start         → Enqueue a scrape job
 *   GET  /api/scraper/status/:id    → Poll job status by scrapeRunId
 *   GET  /api/scraper/status        → Get currently active run
 *   GET  /api/scraper/history       → List recent scrape runs (paginated)
 *   POST /api/scraper/retry/:id     → Re-enqueue a failed scrape run
 *   GET  /api/scraper/queue/metrics → BullMQ queue depth metrics
 */
import { Router, Request, Response } from "express";
import { ObjectId } from "mongodb";
import { getLocationSearchString } from "../../../../Job portal frontend/shared/config/LocationConfig.ts";
import { enqueueScrapeJob } from "../../queue/scrapeQueue.ts";
import {
  createQueuedScrapeRun,
  findScrapeRunById,
  findActiveScrapeRun,
  listScrapeRuns,
  failScrapeRun,
} from "../../database/repositories/ScrapeRunRepository.ts";
import { logger } from "../../logging/logger.ts";
import { scrapeQueue } from "../../queue/scrapeQueue.ts";

export const scraperRouter = Router();

// ─── POST /api/scraper/start ──────────────────────────────────────────────────

scraperRouter.post("/start", async (req: Request, res: Response) => {
  try {
    const {
      country,
      state,
      city,
      sector,
      remoteOnly,
      jobType,
      selectedSources,
      sources: fallbackSources,
      maxPages,
      keywords,
    } = req.body;

    const sources: string[] = selectedSources || fallbackSources || [];

    // ── Validation ─────────────────────────────────────────────────────────
    if (!country || !sector) {
      return res.status(400).json({ error: "country and sector are required" });
    }
    if (!sources.length) {
      return res.status(400).json({ error: "At least one source is required" });
    }

    // ── Check for existing active run ──────────────────────────────────────
    const activeRun = await findActiveScrapeRun();
    if (activeRun) {
      return res.status(409).json({
        error: "A scrape run is already active",
        scrapeRunId: activeRun._id!.toString(),
        status: activeRun.status,
      });
    }

    // ── Build output filename ──────────────────────────────────────────────
    const locToken = city || state || country || "Global";
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const outputFile = `${locToken}_${sector}_${yyyy}${mm}${dd}.csv`.replace(/[^a-zA-Z0-9_.-]/g, "_");

    const location = getLocationSearchString(country, state, city);

    // ── Create MongoDB record (status: queued) ─────────────────────────────
    const runObjectId = await createQueuedScrapeRun({
      country,
      state: state || "",
      city: city || "",
      sector,
      selectedSources: sources,
      remoteOnly: !!remoteOnly,
      jobType: jobType || "",
      maxPages: maxPages || 3,
      keywords: keywords || [],
      searchQueries: keywords?.length ? keywords : [sector],
      locations: [location],
      outputFile,
    });

    const scrapeRunId = runObjectId.toString();

    // ── Enqueue BullMQ job ─────────────────────────────────────────────────
    const queueJobId = await enqueueScrapeJob({
      scrapeRunId,
      country,
      state: state || "",
      city: city || "",
      sector,
      selectedSources: sources,
      remoteOnly: !!remoteOnly,
      jobType: jobType || "",
      maxPages: maxPages || 3,
      keywords: keywords || [],
    });

    await logger.queueCreated(scrapeRunId, queueJobId);
    await logger.apiRequest("POST", "/api/scraper/start", 200);

    return res.json({
      success: true,
      scrapeRunId,
      queueJobId,
      message: `Scrape job queued for ${location} / ${sector}`,
    });
  } catch (err: any) {
    console.error("[POST /api/scraper/start]", err);
    return res.status(500).json({ error: "Failed to start scraper", message: err.message });
  }
});

// ─── GET /api/scraper/status (active run) ────────────────────────────────────

scraperRouter.get("/status", async (req: Request, res: Response) => {
  try {
    const activeRun = await findActiveScrapeRun();

    if (!activeRun) {
      return res.json({ isRunning: false });
    }

    return res.json({
      isRunning: activeRun.status === "running",
      runId: activeRun._id!.toString(),
      scrapeRunId: activeRun._id!.toString(),
      queueJobId: activeRun.queueJobId,
      status: activeRun.status,
      progress: activeRun.progress ?? 0,
      currentStage: activeRun.currentStage ?? "queued",
      currentSource: activeRun.currentSource,
      jobsFound: activeRun.jobsFound ?? 0,
      companiesFound: activeRun.companiesFound ?? 0,
      leadsFound: activeRun.leadsFound ?? 0,
      retryCount: activeRun.retryCount ?? 0,
      startedAt: activeRun.startedAt,
      country: activeRun.country,
      state: activeRun.state,
      city: activeRun.city,
      sector: activeRun.sector,
      selectedSources: activeRun.selectedSources || activeRun.portals || [],
      region: activeRun.locations?.[0] ?? "",
    });
  } catch (err: any) {
    console.error("[GET /api/scraper/status]", err);
    return res.status(500).json({ error: "Failed to get status", message: err.message });
  }
});

// ─── GET /api/scraper/status/:id ─────────────────────────────────────────────

scraperRouter.get("/status/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let runObjectId: ObjectId;
    try {
      runObjectId = new ObjectId(id as string);
    } catch {
      return res.status(400).json({ error: "Invalid scrapeRunId" });
    }

    const run = await findScrapeRunById(runObjectId);
    if (!run) {
      return res.status(404).json({ error: "Scrape run not found" });
    }

    return res.json({
      scrapeRunId: run._id!.toString(),
      queueJobId: run.queueJobId,
      status: run.status,
      isRunning: run.status === "running",
      progress: run.progress ?? 0,
      currentStage: run.currentStage,
      currentSource: run.currentSource,
      jobsFound: run.jobsFound ?? 0,
      companiesFound: run.companiesFound ?? 0,
      leadsFound: run.leadsFound ?? 0,
      retryCount: run.retryCount ?? 0,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      country: run.country,
      state: run.state,
      city: run.city,
      sector: run.sector,
      selectedSources: run.selectedSources || run.portals || [],
      rawLeadsFound: run.rawLeadsFound ?? 0,
      uniqueCompanies: run.uniqueCompanies ?? 0,
      enrichedLeads: run.enrichedLeads ?? 0,
      filteredLeads: run.filteredLeads ?? 0,
      hotLeads: run.hotLeads ?? 0,
      warmLeads: run.warmLeads ?? 0,
      coldLeads: run.coldLeads ?? 0,
      errorMessage: run.errorMessage,
    });
  } catch (err: any) {
    console.error("[GET /api/scraper/status/:id]", err);
    return res.status(500).json({ error: "Failed to get run status", message: err.message });
  }
});

// ─── GET /api/scraper/history ─────────────────────────────────────────────────

scraperRouter.get("/history", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const filters = {
      status: req.query.status as string | undefined,
      country: req.query.country as string | undefined,
      sector: req.query.sector as string | undefined,
    };

    const { data, total } = await listScrapeRuns(page, limit, filters);

    return res.json({
      data: data.map((run) => ({
        _id: run._id!.toString(),
        queueJobId: run.queueJobId,
        status: run.status,
        progress: run.progress ?? 0,
        currentStage: run.currentStage,
        retryCount: run.retryCount ?? 0,
        country: run.country,
        state: run.state,
        city: run.city,
        sector: run.sector,
        sources: run.selectedSources || run.portals || [],
        portals: run.portals || run.selectedSources || [],
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        rawLeadsFound: run.rawLeadsFound ?? 0,
        uniqueCompanies: run.uniqueCompanies ?? 0,
        enrichedLeads: run.enrichedLeads ?? 0,
        filteredLeads: run.filteredLeads ?? 0,
        hotLeads: run.hotLeads ?? 0,
        warmLeads: run.warmLeads ?? 0,
        coldLeads: run.coldLeads ?? 0,
        errorMessage: run.errorMessage,
        searchQueries: run.searchQueries,
        locations: run.locations,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    console.error("[GET /api/scraper/history]", err);
    return res.status(500).json({ error: "Failed to fetch history", message: err.message });
  }
});

// ─── POST /api/scraper/retry/:id ─────────────────────────────────────────────

scraperRouter.post("/retry/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let runObjectId: ObjectId;
    try {
      runObjectId = new ObjectId(id as string);
    } catch {
      return res.status(400).json({ error: "Invalid scrapeRunId" });
    }

    const run = await findScrapeRunById(runObjectId);
    if (!run) return res.status(404).json({ error: "Scrape run not found" });
    if (run.status !== "failed") {
      return res.status(400).json({ error: `Cannot retry a run with status "${run.status}"` });
    }

    const queueJobId = await enqueueScrapeJob({
      scrapeRunId: id as string,
      country: run.country ?? "",
      state: run.state ?? "",
      city: run.city ?? "",
      sector: run.sector ?? "",
      selectedSources: run.selectedSources || run.portals || [],
      maxPages: run.maxPages ?? 3,
      keywords: run.keywords ?? [],
    });

    return res.json({ success: true, scrapeRunId: id as string, queueJobId });
  } catch (err: any) {
    console.error("[POST /api/scraper/retry/:id]", err);
    return res.status(500).json({ error: "Failed to retry job", message: err.message });
  }
});

// ─── GET /api/scraper/queue/metrics ──────────────────────────────────────────

scraperRouter.get("/queue/metrics", async (req: Request, res: Response) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      scrapeQueue.getWaitingCount(),
      scrapeQueue.getActiveCount(),
      scrapeQueue.getCompletedCount(),
      scrapeQueue.getFailedCount(),
      scrapeQueue.getDelayedCount(),
    ]);

    return res.json({
      queueName: "scrape-jobs",
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to get queue metrics", message: err.message });
  }
});

// ─── POST /api/scraper/stop (graceful — marks active as cancelled) ────────────

scraperRouter.post("/stop", async (req: Request, res: Response) => {
  try {
    const activeRun = await findActiveScrapeRun();
    if (!activeRun) {
      return res.json({ success: true, message: "No active run to stop" });
    }

    // If queued (not yet picked up by worker), we can drain it from BullMQ
    if (activeRun.status === "queued" && activeRun.queueJobId) {
      try {
        const job = await scrapeQueue.getJob(activeRun.queueJobId);
        if (job) await job.remove();
      } catch {
        // Job already picked up, can't remove
      }
    }

    // Mark as failed in MongoDB
    await failScrapeRun(
      activeRun._id!,
      "Stopped by user"
    );

    return res.json({ success: true, message: "Scrape run stopped" });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to stop scraper", message: err.message });
  }
});
