# BullMQ + Redis Architecture — ICP Lead Intelligence

## Overview

```
┌─────────────────┐     POST /api/scraper/start      ┌──────────────────────┐
│  Next.js        │ ──────────────────────────────►  │  Express API Server  │
│  Frontend       │                                   │  (npm run api)       │
│  :3001          │ ◄──────────────────────────────── │  :3000               │
└─────────────────┘     { scrapeRunId, queueJobId }   └──────────┬───────────┘
       │                                                          │
       │  GET /api/scraper/status/:id                            │ enqueueScrapeJob()
       │  (polls every 5s)                                       ▼
       │                                              ┌──────────────────────┐
       │                                              │  BullMQ Queue        │
       │                                              │  "scrape-jobs"       │
       │                                              │  Redis :6379         │
       │                                              └──────────┬───────────┘
       │                                                          │ Job picked up
       │                                                          ▼
       │                                              ┌──────────────────────┐
       │                                              │  BullMQ Worker       │
       │                                              │  (npm run worker)    │
       │                                              └──────────┬───────────┘
       │                                                          │
       │                                                          │ runOrchestrator()
       │                                                          ▼
       │                                              ┌──────────────────────┐
       │                                              │  Orchastrater.ts     │
       │                                              │  ├── Scrapers        │
       │                                              │  ├── Enrichers       │
       │                                              │  └── Scorers         │
       │                                              └──────────┬───────────┘
       │                                                          │
       │  progress updates (real-time via MongoDB)               ▼
       │◄──────────────────────────────────────────  ┌──────────────────────┐
                                                      │  MongoDB Atlas        │
                                                      │  scrape_runs         │
                                                      │  scrape_logs         │
                                                      └──────────────────────┘
```

## Data Flow

1. **User clicks "Start Scraping"** → Frontend sends `POST /api/scraper/start` to Next.js route
2. **Next.js proxies** → Express API server at `http://localhost:3000`
3. **Express API**:
   - Creates `scrape_runs` document with `status: "queued"`
   - Enqueues job in BullMQ `scrape-jobs` queue
   - Returns `{ scrapeRunId, queueJobId }` **immediately** (no blocking)
4. **BullMQ Worker** picks up the job (separate process):
   - Updates `scrape_runs.status` → `"running"`
   - Calls `runOrchestrator(params, onProgress)`
   - Progress callback updates MongoDB every milestone
5. **Frontend polls** `GET /api/scraper/status` every 5 seconds
   - Reads from MongoDB, returns live progress fields
6. **On completion**: `scrape_runs.status` → `"completed"`, `progress: 100`
7. **On failure**: Automatic retry up to 3 times with exponential backoff
   - After all retries: job moves to `failed-scrape-jobs` DLQ

---

## File Structure

```
d:\Job Portal Scraper\
├── src/
│   ├── api/
│   │   ├── server.ts                  # Express server (npm run api)
│   │   └── routes/
│   │       └── scraper.ts             # All scraper API routes
│   ├── workers/
│   │   └── scrapeWorker.ts            # BullMQ worker (npm run worker)
│   ├── queue/
│   │   ├── redis.ts                   # Singleton ioredis connection
│   │   ├── scrapeQueue.ts             # BullMQ Queue "scrape-jobs"
│   │   └── failedQueue.ts             # Dead Letter Queue
│   ├── logging/
│   │   └── logger.ts                  # Structured logging (console + MongoDB)
│   ├── database/
│   │   ├── models/
│   │   │   ├── ScrapeRun.ts           # Updated with queue fields
│   │   │   └── Log.ts                 # New: log event model
│   │   └── repositories/
│   │       └── ScrapeRunRepository.ts # Updated with progress functions
│   └── Orchastrater.ts                # Refactored: exports runOrchestrator()
├── packages/
│   ├── shared-types/                  # Monorepo: canonical type contracts
│   ├── shared-config/                 # Monorepo: shared constants
│   └── shared-ui/                     # Monorepo: future shared components
└── apps/
    ├── api/                           # Future: Express app root
    ├── worker/                        # Future: Worker process root
    └── frontend/                      # Future: Next.js app root
```

---

## Redis Setup Guide

### Local Development

Install Redis on Windows using WSL2 or the Windows port:

**Option 1: WSL2 (Recommended)**
```bash
# In WSL2 terminal:
sudo apt update
sudo apt install redis-server
sudo service redis-server start

# Test connection:
redis-cli ping  # should return PONG
```

**Option 2: Memurai (Windows Redis alternative)**
Download from: https://www.memurai.com/

**Option 3: Docker**
```bash
docker run -d -p 6379:6379 --name redis redis:7-alpine
```

### Environment Variables (Local)
```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=       # empty for local
REDIS_TLS=false
REDIS_DB=0
```

### Migrating to Managed Redis (Zero Code Changes)

**Upstash (Recommended for production)**
```env
REDIS_URL=rediss://:your-password@your-host.upstash.io:6379
REDIS_TLS=true
```

**Redis Cloud**
```env
REDIS_HOST=redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com
REDIS_PORT=12345
REDIS_PASSWORD=your-password
REDIS_TLS=true
```

**AWS ElastiCache**
```env
REDIS_HOST=your-cluster.abc123.ng.0001.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_TLS=true
```

> The `redis.ts` module reads `REDIS_URL` first if it's not localhost — no code changes needed.

---

## Worker Setup Guide

### Starting the Worker

```bash
cd "d:\Job Portal Scraper"
npm run worker
```

### Worker Output
```
[Worker] 🔄 Initializing...
[Worker] 📦 MongoDB connected and indexes ready
[Worker] ✅ Listening on queue "scrape-jobs" (concurrency=1)
[Worker] 🔄 Waiting for jobs... (Ctrl+C to stop)

[Worker] 🏃 Job 1 started (runId=6849f123abc...)
[Worker] ✅ Job 1 completed → 47 leads
```

### Concurrency
```env
WORKER_CONCURRENCY=1   # Run 1 job at a time (default, recommended — browser-based scraping)
WORKER_CONCURRENCY=2   # Run 2 jobs in parallel (requires more memory)
```

### Running Both Together (Development)
Open two terminals:
```bash
# Terminal 1: API Server
npm run api

# Terminal 2: Worker
npm run worker
```

---

## Queue Monitoring

### Via API endpoint
```bash
curl http://localhost:3000/api/scraper/queue/metrics
# Returns:
# {
#   "queueName": "scrape-jobs",
#   "waiting": 0,
#   "active": 1,
#   "completed": 23,
#   "failed": 2,
#   "delayed": 0
# }
```

### Via Redis CLI
```bash
redis-cli
# See all BullMQ keys:
KEYS bull:scrape-jobs:*

# Count waiting jobs:
LLEN bull:scrape-jobs:wait

# Count failed jobs:
ZCARD bull:scrape-jobs:failed
```

### Install Bull Board (Optional UI)
```bash
npm install @bull-board/express @bull-board/api
```
Then add to `server.ts`:
```ts
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

const serverAdapter = new ExpressAdapter();
createBullBoard({ queues: [new BullMQAdapter(scrapeQueue)], serverAdapter });
app.use("/admin/queues", serverAdapter.getRouter());
// Visit: http://localhost:3000/admin/queues
```

---

## Deployment Guide

### Production Environment Variables

**Backend API + Worker** (`d:\Job Portal Scraper\.env`):
```env
# MongoDB
MONGODB_URI=mongodb+srv://...
DATABASE_NAME=lead-intelligence

# Redis (use managed Redis in production)
REDIS_URL=rediss://:password@host.upstash.io:6379
REDIS_TLS=true

# API
API_PORT=3000
NODE_ENV=production
CORS_ORIGINS=https://your-frontend-domain.com

# Worker
WORKER_CONCURRENCY=1
```

**Frontend** (`d:\Job portal frontend\.env`):
```env
BACKEND_API_URL=https://your-api-domain.com
NEXT_PUBLIC_API_URL=https://your-api-domain.com
```

### Process Management (Production)

Use PM2 to keep processes alive:
```bash
npm install -g pm2

# Start API
pm2 start "npm run api" --name "icp-api" --cwd "d:/Job Portal Scraper"

# Start Worker
pm2 start "npm run worker" --name "icp-worker" --cwd "d:/Job Portal Scraper"

# Save process list
pm2 save
pm2 startup
```

---

## Retry Strategy

| Attempt | Delay Before | Total Elapsed |
|---------|-------------|---------------|
| 1st (initial) | 0s | 0 min |
| 2nd (retry 1) | 60s | ~1 min |
| 3rd (retry 2) | 120s | ~3 min |
| After 3rd fail | → DLQ | — |

Failed jobs in the `failed-scrape-jobs` DLQ can be manually re-queued via:
```bash
POST http://localhost:3000/api/scraper/retry/:scrapeRunId
```

Or from the History page "Retry" button in the frontend.
