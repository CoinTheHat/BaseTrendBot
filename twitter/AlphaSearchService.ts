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
     * Checks if a token has "Early Alpha" momentum on Twitter.
     * Logic: Search Cashtag -> Filter Live -> Count tweets in last 10 mins.
     * Uses: Browser Context Rotation (Single Browser, Multi Context)
     */
    /**
     * Parallel Batch Scraper (Worker Pool Pattern)
     * Distributes tokens across available accounts.
     */
    async scanBatch(tokens: { symbol: string, name: string }[]): Promise<Map<string, AlphaSearchResult>> {
        const results = new Map<string, AlphaSearchResult>();
        if (!config.ENABLE_TWITTER_SCRAPING || tokens.length === 0) return results;

        const queue = [...tokens];
        const activeWorkers: Promise<void>[] = [];

        // Ensure browser is ready
        await this.ensureBrowser();

        logger.info(`[AlphaHunter] Starting Batch Scan for ${tokens.length} tokens...`);

        // Dynamic Worker Loop
        while (queue.length > 0 || activeWorkers.length > 0) {
            // Check for available accounts
            const account = twitterAccountManager.getAvailableAccount();

            if (account) {
                // Take a chunk for this worker
                // User requested Batch Size = 2 (Reduced from 10 to avoid CPU load)
                const batchSize = 2;
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

    private async processBatchWorker(account: any, tokens: { symbol: string, name: string }[], results: Map<string, AlphaSearchResult>) {
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
                    const result = await this.scrapeSingle(page, token);
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

    private async scrapeSingle(page: any, token: { symbol: string, name: string }): Promise<AlphaSearchResult> {
        let query: string;

        // --- SINGLE SHOT LOGIC (STRICT SOLANA CONTEXT) ---
        // Refined Query to avoid Cross-Chain Confusion (e.g. Clanker on Base vs Solana)

        const symbolPart = `$${token.symbol.toUpperCase()}`;

        // Construct: ($SYMBOL "solana") OR ($SYMBOL "sol") OR ($SYMBOL "mint")
        const inclusions = `(${symbolPart} "solana") OR (${symbolPart} "sol") OR (${symbolPart} "mint")`;

        // Exclusions: -base -eth -bsc -tron -"base chain" -"ethereum"
        const exclusions = `-base -eth -bsc -tron -"base chain" -"ethereum"`;

        query = `${inclusions} ${exclusions}`;

        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;

        try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            await page.waitForSelector('article', { timeout: 5000 });
        } catch (e: any) {
            // Basic timeout / no results
            // logger.debug(`[AlphaHunter] No results for ${query}`);
            return { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
        }

        // Check for "Retry" button (Rate Limit Indicator)
        const hasRetry = await page.$('div[role="button"][aria-label="Retry"]');
        if (hasRetry) {
            // Treat as rate limit
            logger.warn(`[AlphaHunter] 'Retry' button detected for ${token.symbol}. Marking as Rate Limited.`);
            throw new Error('Rate limit detected (Retry Button)');
        }

        // --- SCROLL LOGIC FOR CONTEXT (Getting ~20 tweets) ---
        try {
            for (let i = 0; i < 3; i++) {
                const count = await page.evaluate(() => document.querySelectorAll('article').length);
                if (count >= 20) break;
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

    // Legacy wrapper
    async checkAlpha(symbol: string): Promise<AlphaSearchResult> {
        // Mock name as symbol for legacy calls
        const map = await this.scanBatch([{ symbol, name: symbol }]);
        return map.get(symbol) || { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
    }
}
