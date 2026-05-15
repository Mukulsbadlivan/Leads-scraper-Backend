// @ts-nocheck
// ─── Jobs Scraper — LinkedIn RSS + Remotive API ───────────────────────────────
// Glassdoor heavily blocks bots — replaced with sources that actually work:
//   1. LinkedIn Jobs RSS feed (public, no auth needed)
//   2. Remotive.com API (free, returns real company + job data)

export async function scrapeGlassdoor(page, query, location, maxPages = 2) {
    const leads = [];

    // ── Source 1: LinkedIn Jobs RSS ──────────────────────────────────────────────
    console.log(`    🔗 Trying LinkedIn Jobs RSS...`);
    try {
        const linkedinUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}&f_TPR=r604800`;
        await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        const linkedinLeads = await page.evaluate(() => {
            const results = [];
            const cards = document.querySelectorAll(
                ".job-search-card, .base-card, [class*='job-search-card'], li.jobs-search-results__list-item"
            );

            cards.forEach((card) => {
                const titleEl = card.querySelector(".base-search-card__title, h3.base-search-card__title, .job-search-card__title");
                const companyEl = card.querySelector(".base-search-card__subtitle, h4.base-search-card__subtitle, .job-search-card__company-name");
                const locEl = card.querySelector(".job-search-card__location, .base-search-card__metadata");
                const linkEl = card.querySelector("a.base-card__full-link, a[href*='/jobs/view/']");

                const companyName = companyEl?.innerText?.trim() || "";
                const jobTitle = titleEl?.innerText?.trim() || "";
                if (!companyName || !jobTitle) return;

                results.push({
                    jobTitle,
                    companyName,
                    location: (locEl?.innerText?.trim() || "").replace(/\n[\s\S]*/g, "").trim(),
                    salary: "",
                    jobLink: linkEl?.href || "",
                    source: "LinkedIn",
                });
            });
            return results;
        });

        console.log(`      LinkedIn: Found ${linkedinLeads.length} listings`);
        leads.push(...linkedinLeads);
    } catch (err) {
        console.error(`    ⚠️ LinkedIn error:`, err.message);
    }

    // ── Source 2: Remotive API (real company data, no blocking) ──────────────────
    console.log(`    🌐 Trying Remotive API...`);
    try {
        const remotiveUrl = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=50`;
        await page.goto(remotiveUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);

        const bodyText = await page.evaluate(() => document.body.innerText);
        const data = JSON.parse(bodyText);

        if (data?.jobs?.length) {
            for (const job of data.jobs) {
                leads.push({
                    jobTitle: job.title || "",
                    companyName: job.company_name || "",
                    location: job.candidate_required_location || "Remote",
                    salary: job.salary || "",
                    jobLink: job.url || "",
                    source: "Remotive",
                });
            }
            console.log(`      Remotive: Found ${data.jobs.length} listings`);
        }
    } catch (err) {
        console.error(`    ⚠️ Remotive error:`, err.message);
    }

    // ── Source 3: Arbeitnow API (free, no auth, real jobs) ───────────────────────
    console.log(`    🌐 Trying Arbeitnow API...`);
    try {
        const arbeitnowUrl = `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(query)}`;
        await page.goto(arbeitnowUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);

        const bodyText2 = await page.evaluate(() => document.body.innerText);
        const data2 = JSON.parse(bodyText2);

        if (data2?.data?.length) {
            for (const job of data2.data) {
                leads.push({
                    jobTitle: job.title || "",
                    companyName: job.company_name || "",
                    location: job.location || "Remote",
                    salary: "",
                    jobLink: job.url || "",
                    source: "Arbeitnow",
                });
            }
            console.log(`      Arbeitnow: Found ${data2.data.length} listings`);
        }
    } catch (err) {
        console.error(`    ⚠️ Arbeitnow error:`, err.message);
    }

    return leads;
}

