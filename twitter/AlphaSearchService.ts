import { twitterAccountManager } from './TwitterAccountManager';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/Logger';
import { config } from '../config/env';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
puppeteer.use(StealthPlugin());

export interface AlphaSearchResult {
    velocity: number; // Tweets in last 10 mins
    uniqueAuthors: number; // Unique users
    tweets: string[];
    isEarlyAlpha: boolean; // > 10 distinct/valid tweets
    isSuperAlpha: boolean; // > 30 distinct/valid tweets
}

export class AlphaSearchService {
    private browser: any = null;

    constructor() {
        // Lazy load
    }

    private async ensureBrowser() {
        if (this.browser) {
            if (this.browser.isConnected()) return;
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
     * Hybrid Batch Scraper (Bird CLI -> Puppeteer Fallback)
     */
    async scanBatch(tokens: { symbol: string, name: string, address?: string }[]): Promise<Map<string, AlphaSearchResult>> {
        const results = new Map<string, AlphaSearchResult>();
        if (!config.ENABLE_TWITTER_SCRAPING || tokens.length === 0) return results;

        const puppeteerQueue: typeof tokens = [];

        // --- PHASE 1: BIRD CLI (Fast & Lightweight) ---
        logger.info(`[AlphaHunter] 🦅 Starting Hybrid Scan for ${tokens.length} tokens...`);

        await Promise.all(tokens.map(async (token) => {
            try {
                // Priority: Contract Address -> Symbol
                // Search Query: CA OR ($SYMBOL "base")
                let query = '';

                if (token.address) {
                    query = `${token.address} OR ($${token.symbol} "base")`;
                } else {
                    query = `($${token.symbol} "base") OR ($${token.symbol} "on base") -solana`;
                }

                const birdResult = await this.searchWithBirdCLI(query);

                if (birdResult && birdResult.tweets.length > 0) {
                    logger.info(`[AlphaHunter] 🦅 Bird CLI Hit for ${token.symbol}: ${birdResult.velocity} velocity`);
                    results.set(token.symbol, birdResult);
                } else {
                    // Fallback to Puppeteer if Bird finds nothing (or fails)
                    puppeteerQueue.push(token);
                }
            } catch (err) {
                // If Bird fails, add to fallback queue
                puppeteerQueue.push(token);
            }
        }));

        logger.info(`[AlphaHunter] 🦅 Phase 1 Complete. Hits: ${results.size}. Fallback Queue: ${puppeteerQueue.length}`);

        if (puppeteerQueue.length === 0) return results;

        // --- PHASE 2: PUPPETEER (Legacy Fallback) ---
        // Only launch browser if we have fallback items
        const queue = [...puppeteerQueue];
        const activeWorkers: Promise<void>[] = [];

        await this.ensureBrowser();

        while (queue.length > 0 || activeWorkers.length > 0) {
            const account = twitterAccountManager.getAvailableAccount();

            if (account) {
                const batchSize = 2;
                const chunk = queue.splice(0, batchSize);

                if (chunk.length > 0) {
                    const workerPromise = this.processBatchWorker(account, chunk, results).then(() => {
                        const idx = activeWorkers.indexOf(workerPromise);
                        if (idx > -1) activeWorkers.splice(idx, 1);
                    });
                    activeWorkers.push(workerPromise);
                } else {
                    twitterAccountManager.releaseAccount(account.index, false);
                }
            }

            if (queue.length === 0 && activeWorkers.length > 0) {
                await Promise.all(activeWorkers);
                break;
            }

            if (queue.length > 0 && !account) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        return results;
    }

    /**
     * Executes 'bird search' via CLI
     */
    private async searchWithBirdCLI(query: string): Promise<AlphaSearchResult | null> {
        try {
            // Command: bird search "query" --json
            // Note: Ensuring query is strictly quoted to avoid shell injection/issues is tricky but basic quoting should work.
            // Using a simple sanitize:
            const safeQuery = query.replace(/"/g, '\\"');
            const cmd = `bird search "${safeQuery}" --json`;

            const { stdout } = await execAsync(cmd, { timeout: 15000 }); // 15s timeout

            // Expected output: JSON array of tweets or object structure
            // We need to parse this. Assuming it returns a list of tweets.
            // If output is raw text mixed with JSON, we might need to extract JSON.
            // Assuming strict JSON output with --json flag.

            const data: any = JSON.parse(stdout);

            // Normalize Data
            // data structure depends on bird CLI. Assuming standard Tweet objects.
            // If it returns { tweets: [...] } or just [...]
            const tweets = Array.isArray(data) ? data : (data.tweets || []);

            if (tweets.length === 0) return null;

            const now = Date.now();
            const tenMinsAgo = now - (10 * 60 * 1000);

            const processedTweets = tweets.map((t: any) => {
                const timeStr = t.created_at || t.date || t.time; // Heuristic
                const text = t.text || t.full_text || t.content || "";
                const handle = t.user?.screen_name || t.handle || "unknown";

                const timeVal = timeStr ? new Date(timeStr).getTime() : 0;

                return {
                    text,
                    handle,
                    isRecent: timeVal > tenMinsAgo
                };
            });

            const recent = processedTweets.filter((t: any) => t.isRecent);
            const authors = new Set(processedTweets.map((t: any) => t.handle));
            const allTexts = processedTweets.map((t: any) => t.text);

            return {
                velocity: recent.length,
                uniqueAuthors: authors.size,
                tweets: allTexts,
                isEarlyAlpha: authors.size >= 10,
                isSuperAlpha: authors.size >= 30
            };

        } catch (error) {
            // logger.debug(`[Bird CLI] Failed: ${error}`);
            return null;
        }
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

            for (const token of tokens) {
                try {
                    const result = await this.scrapeSingle(page, token);
                    results.set(token.symbol, result);
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                } catch (e: any) {
                    if (e.message.includes('Rate limit') || e.message.includes('Too Many Requests')) {
                        logger.warn(`[AlphaHunter] Worker #${account.index + 1} HIT RATE LIMIT.`);
                        rateLimited = true;
                        break;
                    }
                }
            }

        } catch (err: any) {
            logger.error(`[AlphaHunter] Worker #${account.index + 1} Critial Error: ${err.message}`);
        } finally {
            if (context) {
                try { await context.close(); } catch (e) { }
            }
            twitterAccountManager.releaseAccount(account.index, rateLimited);
        }
    }

    private async scrapeSingle(page: any, token: { symbol: string, name: string }): Promise<AlphaSearchResult> {
        let query: string;

        // Legacy/Puppeteer Query Logic
        const symbolPart = `$${token.symbol.toUpperCase()}`;
        const inclusions = `(${symbolPart} "base") OR (${symbolPart} "on base") OR (${symbolPart} "basechain")`;
        const exclusions = `-solana -sol -eth -bsc -tron -"solana chain" -"ethereum"`;
        query = `${inclusions} ${exclusions}`;

        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;

        try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            await page.waitForSelector('article', { timeout: 5000 });
        } catch (e: any) {
            return { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
        }

        const hasRetry = await page.$('div[role="button"][aria-label="Retry"]');
        if (hasRetry) {
            throw new Error('Rate limit detected (Retry Button)');
        }

        try {
            for (let i = 0; i < 3; i++) {
                const count = await page.evaluate(() => document.querySelectorAll('article').length);
                if (count >= 20) break;
                await page.evaluate(() => window.scrollBy(0, 1500));
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) { }

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

        const allTweets = tweetData.map((t: any) => t.text).slice(0, 20);
        const recentTweets = tweetData.filter((t: any) => t.isRecent);
        const authors = new Set(recentTweets.map((t: any) => t.handle));

        return {
            velocity: recentTweets.length,
            uniqueAuthors: authors.size,
            tweets: allTweets,
            isEarlyAlpha: authors.size >= 10,
            isSuperAlpha: authors.size >= 30
        };
    }

    // Wrapper updated to accept address
    async checkAlpha(symbol: string, address?: string): Promise<AlphaSearchResult> {
        const map = await this.scanBatch([{ symbol, name: symbol, address }]);
        return map.get(symbol) || { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
    }
}
