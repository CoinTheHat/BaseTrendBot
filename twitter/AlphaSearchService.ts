import { twitterAccountManager } from './TwitterAccountManager';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/Logger';
import { config } from '../config/env';

puppeteer.use(StealthPlugin());

export interface AlphaSearchResult {
    velocity: number; // Tweets in last 10 mins
    uniqueAuthors: number; // Unique users
    tweets: string[];
    isEarlyAlpha: boolean;
    isSuperAlpha: boolean;
}

export class AlphaSearchService {
    private browser: any = null;

    constructor() {
        // Pre-launch browser? Or lazy load. Lazy load is safer for stability.
    }

    private async ensureBrowser() {
        if (this.browser) {
            if (this.browser.isConnected()) return;
            // If disconnected, kill and restart
            try { await this.browser.close(); } catch (e) { }
            this.browser = null;
        }

        this.browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        logger.info('[AlphaHunter] 🌐 Main Browser Instance Launched.');
    }

    /**
     * HYBRID SEARCH: bird.fast CLI (GraphQL)
     * Faster than Puppeteer scraping. Uses Twitter's GraphQL API.
     * Returns null on failure to trigger Puppeteer fallback.
     */
    private async searchWithBirdFast(query: string, account: any): Promise<AlphaSearchResult | null> {
        if (!config.ENABLE_TWITTER_SCRAPING) return null;

        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execPromise = promisify(exec);

        try {
            // Build bird.fast search command
            // Use npx bird: works on Windows/Linux and uses local node_modules binary
            // ESCAPE QUOTES AND DOLLAR SIGNS: On Linux, $SYMBOL is treated as a variable and removed if not escaped!
            // BUT: On Windows, \$ is treated literally as a backslash + $, which breaks the search.
            const isWindows = process.platform === 'win32';
            const safeQuery = isWindows
                ? query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                : query.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');

            const command = `npx @steipete/bird search "${safeQuery}" --count 100 --json`;

            const env = {
                ...process.env,
                AUTH_TOKEN: account.authToken,
                CT0: account.ct0
            };

            logger.info(`[bird.fast] Searching for: ${query.substring(0, 80)}...`);

            const { stdout, stderr } = await Promise.race([
                execPromise(command, {
                    env,
                    timeout: 20000, // Increased timeout for larger dataset
                    maxBuffer: 2 * 1024 * 1024 // 2MB buffer
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('bird.fast timeout')), 20000)
                )
            ]) as any;

            if (stderr && !stderr.includes('Warning')) {
                logger.warn(`[bird.fast] stderr: ${stderr.substring(0, 200)}`);
            }

            // Parse JSON output
            // bird search returns a top-level ARRAY of tweets, not { tweets: [] }
            const rawTweets = JSON.parse(stdout);
            const tweetsList = Array.isArray(rawTweets) ? rawTweets : (rawTweets.tweets || []);

            if (!tweetsList || tweetsList.length === 0) {
                logger.info(`[bird.fast] No tweets found for query. Raw stdout length: ${stdout.length}`);
                if (stderr) logger.warn(`[bird.fast] (Empty Result) stderr: ${stderr.substring(0, 200)}`);
                return null;
            }

            // Transform bird.fast output to our AlphaSearchResult format
            const now = Date.now();
            const windowMs = 4 * 60 * 60 * 1000; // 4 Hours (User Request: Abundance of data for anti-shill)

            const tweets = tweetsList.map((t: any) => t.text || t.full_text || '');
            const recentTweets = tweetsList.filter((t: any) => {
                const tweetTime = new Date(t.createdAt || t.created_at).getTime();
                return (now - tweetTime) < windowMs;
            });

            const authors = new Set(recentTweets.map((t: any) => t.user?.screen_name || 'unknown'));

            logger.info(`[bird.fast] ✅ Found ${tweets.length} tweets (${recentTweets.length} in 4h, ${authors.size} authors)`);

            return {
                velocity: recentTweets.length,
                uniqueAuthors: authors.size,
                tweets: tweets.slice(0, 100), // Limit to 100
                isEarlyAlpha: authors.size >= 10,
                isSuperAlpha: authors.size >= 30
            };

        } catch (error: any) {
            if (error.message.includes('timeout')) {
                logger.warn(`[bird.fast] ⏱️ Timeout for query. Falling back to Puppeteer.`);
            } else {
                // Log the actual error to understand why it failed (it might be exit code 1, auth error, etc)
                logger.error(`[bird.fast] ❌ Execution Failed: ${error.message}`);
                if (error.stderr) {
                    logger.error(`[bird.fast] stderr: ${error.stderr.substring(0, 300)}`);
                }
            }
            return null; // Trigger Puppeteer fallback
        }
    }

    /**
     * Checks if a token has "Early Alpha" momentum on Twitter.
     * Logic: Search Cashtag -> Filter Live -> Count tweets in last 10 mins.
     * Uses: Browser Context Rotation (Single Browser, Multi Context)
     */
    /**
     * Parallel Batch Scraper (Worker Pool Pattern)
     * Distributes tokens across available accounts.
     */
    async scanBatch(tokens: { symbol: string, name: string, mint?: string }[]): Promise<Map<string, AlphaSearchResult>> {
        const results = new Map<string, AlphaSearchResult>();
        if (!config.ENABLE_TWITTER_SCRAPING || tokens.length === 0) return results;

        const queue = [...tokens];
        const activeWorkers: Promise<void>[] = [];

        // No pre-launching browser here. Let ensureBrowser be called by workers only if needed.

        logger.info(`[AlphaHunter] Starting Batch Scan for ${tokens.length} tokens...`);

        // Dynamic Worker Loop
        while (queue.length > 0 || activeWorkers.length > 0) {
            // Check for available accounts
            const account = twitterAccountManager.getAvailableAccount();

            if (account) {
                // Take a chunk for this worker
                // User increased accounts to 15+. Increasing batchSize to 5 for high throughput.
                const batchSize = 5;
                const chunk = queue.splice(0, batchSize);

                if (chunk.length > 0) {
                    const workerPromise = this.processBatchWorker(account, chunk, results).then(() => {
                        // Worker finished, remove from active list
                        const idx = activeWorkers.indexOf(workerPromise);
                        if (idx > -1) activeWorkers.splice(idx, 1);
                    });
                    activeWorkers.push(workerPromise);
                } else {
                    // Account claimed but queue empty, release immediately
                    twitterAccountManager.releaseAccount(account.index, false);
                }
            }

            // Main loop wait (if queue is empty but workers running, just wait for them)
            if (queue.length === 0 && activeWorkers.length > 0) {
                await Promise.all(activeWorkers);
                break;
            }

            // If queue has items but no account, wait 5s (Accounts cool down fast now)
            if (queue.length > 0 && !account) {
                logger.info(`[AlphaQueue] ⏳ All accounts busy/cooling. Queue: ${queue.length}. Waiting 5s...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        return results;
    }

    private async processBatchWorker(account: any, tokens: { symbol: string, name: string, mint?: string }[], results: Map<string, AlphaSearchResult>) {
        let context: any = null;
        let page: any = null;
        let rateLimited = false;

        logger.info(`[AlphaHunter] Worker #${account.index + 1} starting batch of ${tokens.length} tokens.`);

        try {
            if (!this.browser) await this.ensureBrowser();

            context = await this.browser.createBrowserContext();
            page = await context.newPage();

            // Resource Blocking (User Request)
            await page.setRequestInterception(true);
            page.on('request', (req: any) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.setUserAgent(account.userAgent);
            await page.setCookie(
                { name: 'auth_token', value: account.authToken, domain: '.twitter.com' },
                { name: 'ct0', value: account.ct0, domain: '.twitter.com' }
            );

            // Sequential processing within this worker
            for (const token of tokens) {
                try {
                    const result = await this.scrapeSingle(page, token, account);
                    results.set(token.symbol, result);

                    // Small tactical delay between searches in same session
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                } catch (e: any) {
                    if (e.message.includes('Rate limit') || e.message.includes('Too Many Requests')) {
                        logger.warn(`[AlphaHunter] Worker #${account.index + 1} HIT RATE LIMIT.`);
                        rateLimited = true;
                        break; // Stop this batch
                    }
                    logger.error(`[AlphaHunter] Worker #${account.index + 1} failed on ${token.symbol}: ${e.message}`);
                }
            }

        } catch (err: any) {
            logger.error(`[AlphaHunter] Worker #${account.index + 1} Critial Error: ${err.message}`);
        } finally {
            if (context) {
                try { await context.close(); } catch (e) { }
            }
            logger.info(`[AlphaHunter] Worker #${account.index + 1} finished. releasing (RateLimited: ${rateLimited})`);
            twitterAccountManager.releaseAccount(account.index, rateLimited);
        }
    }

    private async scrapeSingle(page: any, token: { symbol: string, name: string, mint?: string }, account: any): Promise<AlphaSearchResult> {
        let query: string;

        // --- SIMPLIFIED QUERY ---
        // REALITY CHECK: People tweet "$SYMBOL", NOT contract addresses.
        // CA tweets are EXTREMELY rare. Always use $SYMBOL for max hit rate.
        query = `$${token.symbol.toUpperCase()}`;

        // --- HYBRID SEARCH: Try bird.fast (GraphQL) first ---
        // RETRY LOGIC: If a cookie is dead, try up to 2 other accounts
        let birdResult: AlphaSearchResult | null = null;
        let usedAccountIndices = new Set<number>([account.index]);

        // Attempt 1 (Current Account)
        birdResult = await this.searchWithBirdFast(query, account);

        // If failed or empty, try other accounts (Max 2 retries)
        if (!birdResult) {
            for (let i = 0; i < 2; i++) {
                logger.info(`[Hybrid] 🔄 bird.fast returned no results/error. Retrying with different account (Attempt ${i + 2}/3)...`);

                // Get a temporary account usage (just for this search)
                const backupAccount = twitterAccountManager.getAvailableAccount();

                if (backupAccount && !usedAccountIndices.has(backupAccount.index)) {
                    usedAccountIndices.add(backupAccount.index);
                    birdResult = await this.searchWithBirdFast(query, backupAccount);

                    // Release immediately after single use
                    twitterAccountManager.releaseAccount(backupAccount.index, false);

                    if (birdResult) {
                        logger.info(`[Hybrid] ✅ bird.fast succeeded on Attempt ${i + 2}`);
                        break;
                    }
                } else {
                    if (backupAccount) twitterAccountManager.releaseAccount(backupAccount.index, false);
                    logger.warn(`[Hybrid] No fresh accounts available for retry.`);
                    break;
                }
            }
        }

        if (birdResult) {
            return birdResult;
        }

        // --- FALLBACK: Puppeteer HTML Scraping ---
        logger.info(`[Hybrid] 🔄 Falling back to Puppeteer for ${token.symbol}`);

        // Simplify Query for Puppeteer (HTML scraping is fragile with complex queries)
        // If complex CA query failed, maybe Puppeteer can find $SYMBOL at least
        // But for consistent comparison, let's keep the query robust first. 

        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;

        try {
            // Increased timeout to 20s for page load (Twitter is slow)
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

            // Increased selector timeout to 15s
            await page.waitForSelector('article', { timeout: 15000 });
        } catch (e: any) {
            // Basic timeout / no results
            logger.warn(`[AlphaHunter] No results/Timeout for ${token.symbol}. Query: ${query}`);

            // CAPTURE SCREENSHOT FOR DEBUGGING
            try {
                const screenshotPath = `twitter_fail_${token.symbol}_${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath });
                logger.info(`[AlphaHunter] 📸 Screenshot saved: ${screenshotPath}`);
            } catch (err) { }

            return { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
        }

        // Check for "Retry" button (Rate Limit Indicator)
        const hasRetry = await page.$('div[role="button"][aria-label="Retry"]');
        if (hasRetry) {
            // Treat as rate limit
            logger.warn(`[AlphaHunter] 'Retry' button detected for ${token.symbol}. Marking as Rate Limited.`);
            throw new Error('Rate limit detected (Retry Button)');
        }

        // --- SCROLL LOGIC FOR CONTEXT (Getting ~50 tweets) ---
        try {
            for (let i = 0; i < 5; i++) {
                const count = await page.evaluate(() => document.querySelectorAll('article').length);
                if (count >= 50) break;
                await page.evaluate(() => window.scrollBy(0, 1500));
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {
            // Ignore scroll errors
        }

        // Extraction
        const tweetData: any[] = await page.evaluate(() => {
            const now = Date.now();
            const minutes10 = 10 * 60 * 1000;
            const articles = Array.from(document.querySelectorAll('article'));
            return articles.map(article => {
                const timeEl = article.querySelector('time');
                const textEl = article.querySelector('div[data-testid="tweetText"]');
                const userEl = article.querySelector('div[data-testid="User-Name"] a');
                if (!timeEl || !textEl) return null;
                const timeStr = timeEl.getAttribute('datetime');
                const text = textEl.textContent || "";
                const handle = userEl ? userEl.getAttribute('href') : "unknown";
                if (!timeStr) return null;
                const timeVal = new Date(timeStr).getTime();
                return {
                    time: timeVal, text, handle,
                    isRecent: (now - timeVal) < minutes10
                };
            }).filter(t => t !== null);
        });

        // Use ALL fetched tweets for analysis context (Limited to 20), but only RECENT for Velocity
        const allTweets = tweetData.map((t: any) => t.text).slice(0, 20);
        const recentTweets = tweetData.filter((t: any) => t.isRecent);
        const authors = new Set(recentTweets.map((t: any) => t.handle));

        return {
            velocity: recentTweets.length,
            uniqueAuthors: authors.size,
            tweets: allTweets, // Send full context for AI
            isEarlyAlpha: authors.size >= 10,
            isSuperAlpha: authors.size >= 30
        };
    }

    // Legacy wrapper (Updated to support mint)
    async checkAlpha(symbol: string, mint?: string): Promise<AlphaSearchResult> {
        // Mock name as symbol for legacy calls, pass mint if available
        const map = await this.scanBatch([{ symbol, name: symbol, mint }]);
        return map.get(symbol) || { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
    }
}
