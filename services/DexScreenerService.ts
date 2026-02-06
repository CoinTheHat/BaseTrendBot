import axios from 'axios';
import { chromium } from 'playwright-extra';
import { Browser, BrowserContext } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';
import * as dotenv from 'dotenv';
import path from 'path';

// Apply Stealth Plugin to Chromium
// @ts-ignore
chromium.use(stealth());

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Force Playwright to look for browsers in the project directory (Critical for Railway persistence)
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.cwd(), '.playwright-browsers');

export class DexScreenerService {
    private apiUrl = 'https://api.dexscreener.com/latest/dex';

    // Persistent Browser State
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private isInitializing = false;

    // Rate Limit State
    private lastRequestTime = 0;
    private minDelayMs = 200;

    constructor() { }

    /**
     * Initialize or Reuse Persistent Browser
     * Critical for performance when making 100+ checks
     */
    private async getBrowserContext(): Promise<BrowserContext> {
        if (this.context) return this.context;

        // Prevent race conditions during init
        while (this.isInitializing) {
            await new Promise(r => setTimeout(r, 100));
            if (this.context) return this.context;
        }

        this.isInitializing = true;
        try {
            if (!this.browser) {
                logger.info('[DexScreener] 🚀 Launching Persistent Browser (Playwright)...');
                // @ts-ignore
                this.browser = await chromium.launch({
                    headless: true,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu'
                    ]
                });
            }

            this.context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 },
                locale: 'en-US',
                timezoneId: 'America/New_York',
            });

            // GLOBAL OPTIMIZATION: Block heavy resources on ALL pages in this context
            await this.context.route('**/*.{png,jpg,jpeg,gif,webp,svg,css,woff,woff2}', route => route.abort());

            // Global Stealth Scripts
            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                // @ts-ignore
                window.chrome = { runtime: {} };
                const originalQuery = window.navigator.permissions.query;
                // @ts-ignore
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters)
                );
            });

            return this.context;

        } catch (err) {
            logger.error('[DexScreener] Browser Init Failed:', err);
            this.isInitializing = false;
            throw err;
        } finally {
            this.isInitializing = false;
        }
    }

    /**
     * Fetch latest Base profiles/pairs.
     * Strategy: Scrape ~150 pair addresses -> Filter -> Return Top 100
     */
    async getLatestPairs(): Promise<TokenSnapshot[]> {
        try {
            logger.info(`[DexScreener] Scraping M5 trending pairs via Persistent Browser...`);

            // 1. Get pair addresses using Playwright (Target: 150 to ensure 100 valid)
            const pairAddresses = await this.scrapePairAddresses(150);

            if (pairAddresses.length === 0) {
                logger.warn(`[DexScreener] Found 0 pairs via scraping. Falling back to search...`);
                return (await this.search("base")).slice(0, 100);
            }

            logger.info(`[DexScreener] Found ${pairAddresses.length} pairs. Fetching full data via API...`);

            // 2. Fetch full data via API (Bulk)
            const results: TokenSnapshot[] = [];
            const chunks = this.chunkArray(pairAddresses, 30); // Max 30 per API call

            for (const chunk of chunks) {
                try {
                    const url = `${this.apiUrl}/pairs/base/${chunk.join(',')}`;
                    const data = await this.makeRequest(url);
                    const pairs = data?.pairs || [];

                    const validTokens = pairs
                        .map((p: any) => this.normalizePair(p))
                        .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null)
                        .filter((p: TokenSnapshot) => {
                            // PRE-FILTER: Too Old (>168 Hours / 7 Days)
                            if (!p.createdAt) return true;
                            const ageHours = (Date.now() - p.createdAt.getTime()) / 3600000;
                            return ageHours <= 168;
                        });

                    results.push(...validTokens);
                } catch (err) {
                    logger.error(`[DexScreener] Error fetching pair chunk:`, err);
                }
            }

            // Return Top 100
            const final = results.slice(0, 100);
            logger.info(`[DexScreener] Successfully retrieved ${final.length} tokens for analysis.`);
            return final;

        } catch (error) {
            logger.error('[DexScreener] Hybrid fetching failed:', error);
            return [];
        }
    }

    /**
     * Access DexScreener Internal API v4 using Reused Page
     * Optimized for speed: uses verify-fast approach
     */
    async getPairDetails(pairAddress: string): Promise<{
        holderCount: number;
        top10Percent: number;
        security: { isMintable: boolean; isFreezable: boolean };
        liquidity: { burnedPercent: number; totalLockedPercent: number; locks: any[] };
        isCTO: boolean;
    } | null> {
        let page: any = null;
        try {
            const context = await this.getBrowserContext();
            page = await context.newPage();

            // Aggressive Timeout for Speed
            await page.goto(`https://io.dexscreener.com/dex/pair-details/v4/base/${pairAddress}`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            const content = await page.evaluate(() => document.body.innerText);

            try {
                const json = JSON.parse(content);
                const baseToken = json.baseToken || {};
                // Note: ta (token authority) for Base/EVM is often under 'ethereum' or 'evm' key in their internal API
                // but baseToken usually has the direct flags.
                const tokenAuth = json.ta?.ethereum || json.ta?.solana || {};

                // Calculate Top 10 Percent manually
                const holdersList = json.holders?.holders || [];
                const top10PercentResult = holdersList
                    .sort((a: any, b: any) => (parseFloat(b.percentage) || 0) - (parseFloat(a.percentage) || 0))
                    .slice(0, 10)
                    .reduce((acc: number, curr: any) => acc + (parseFloat(curr.percentage) || 0), 0);

                const locks = json.ll?.locks || [];
                const burnedPercent = json.ll?.burned || 0;
                const totalLockedPercent = (json.ll?.totalPercentage || 0);

                return {
                    holderCount: json.holders?.count !== undefined ? json.holders.count : 0,
                    top10Percent: top10PercentResult,
                    security: {
                        isMintable: !!tokenAuth.isMintable || !!baseToken.mintAuthority,
                        isFreezable: !!tokenAuth.isFreezable || !!baseToken.freezeAuthority
                    },
                    liquidity: {
                        burnedPercent: burnedPercent,
                        totalLockedPercent: totalLockedPercent,
                        locks: locks
                    },
                    isCTO: (json.cms?.claims?.length || 0) > 1
                };

            } catch (parseErr) {
                return null;
            }

        } catch (err) {
            // logger.debug(`[DexInternal] Fetch failed for ${pairAddress}: ${err.message}`);
            return null;
        } finally {
            if (page) await page.close(); // Only close the page, keep browser/context alive
        }
    }

    /**
     * Robust Scraper with Infinite Scroll
     */
    private async scrapePairAddresses(limit: number): Promise<string[]> {
        let page: any = null;
        try {
            const context = await this.getBrowserContext();
            page = await context.newPage();

            const url = 'https://dexscreener.com/base?rankBy=trendingScoreM5&order=desc';
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

            let tokens = new Set<string>();
            let scrollAttempts = 0;
            const maxScrolls = 20; // Increased to ensure we hit 100+
            let sameCount = 0;

            // Initial wait for content
            try {
                await page.waitForSelector('a[href^="/base/"]', { timeout: 10000 });
            } catch (e) {
                logger.warn('[DexScreener] Timeout waiting for initial list.');
            }

            while (tokens.size < limit && scrollAttempts < maxScrolls) {
                // Collect visible tokens first
                const newTokens = await page.$$eval('a[href*="/base/"]', (links: any[]) =>
                    links.map(link => {
                        const href = link.getAttribute('href');
                        const match = href?.match(/\/base\/([A-Za-z0-9]+)/);
                        return match ? match[1] : null;
                    }).filter(Boolean)
                );

                const prevSize = tokens.size;
                newTokens.forEach((t: string) => tokens.add(t));

                if (tokens.size === prevSize) {
                    sameCount++;
                } else {
                    sameCount = 0; // Reset if we found new ones
                }

                // Break if stuck
                if (sameCount >= 3 && tokens.size > 20) {
                    // logger.debug('[DexScreener] Stuck at same count, breaking early.');
                    break;
                }

                if (tokens.size >= limit) break;

                // Perform Scroll
                await page.evaluate(() => {
                    const scrollAmount = document.body.scrollHeight * 0.8; // Not full bottom to trigger lazy load better
                    window.scrollTo(0, scrollAmount);
                    // Tiny separate scroll to trigger events
                    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 200);
                });

                // Wait for network/dom update
                await page.waitForTimeout(2000); // 2s wait
                scrollAttempts++;
            }

            logger.debug(`[DexScreener] Scrape result: ${tokens.size} pairs (Target: ${limit})`);
            return Array.from(tokens);

        } catch (error) {
            logger.error('[DexScreener] Scraping logic error:', error);
            try { if (this.browser) await this.browser.close(); this.browser = null; this.context = null; } catch { }
            return [];
        } finally {
            if (page) await page.close();
        }
    }


    // --- Helper Methods ---

    async getTokens(mints: string[]): Promise<TokenSnapshot[]> {
        if (mints.length === 0) return [];
        const chunks = this.chunkArray(mints, 30);
        const results: TokenSnapshot[] = [];

        for (const chunk of chunks) {
            try {
                const url = `${this.apiUrl}/tokens/${chunk.join(',')}`;
                const data = await this.makeRequest(url);
                const pairs = data?.pairs || [];
                const validPairs = pairs
                    .map((p: any) => this.normalizePair(p))
                    .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null);
                results.push(...validPairs);
            } catch (error) {
                logger.error(`[DexScreener] Error fetching tokens chunk:`, error);
            }
        }
        return results;
    }

    async search(query: string): Promise<TokenSnapshot[]> {
        try {
            const data = await this.makeRequest(`${this.apiUrl}/search?q=${encodeURIComponent(query)}`);
            return (data?.pairs || [])
                .map((p: any) => this.normalizePair(p))
                .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null);
        } catch (error) {
            logger.error(`[DexScreener] Search failed for '${query}':`, error);
            return [];
        }
    }

    private async makeRequest(url: string, retries = 3): Promise<any> {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        if (timeSinceLast < this.minDelayMs) {
            await new Promise(resolve => setTimeout(resolve, this.minDelayMs - timeSinceLast));
        }
        this.lastRequestTime = Date.now();

        for (let i = 0; i < retries; i++) {
            try {
                const response = await axios.get(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    timeout: 5000
                });
                return response.data;
            } catch (error: any) {
                if (i === retries - 1) throw error;
                await new Promise(res => setTimeout(res, 500 * (i + 1)));
            }
        }
    }

    private normalizePair(pair: any): TokenSnapshot | null {
        if (pair?.chainId !== 'base') return null;
        const tokenAddress = pair.baseToken?.address || '';
        if (!tokenAddress.startsWith('0x')) return null;

        return {
            source: 'dexscreener',
            mint: tokenAddress,
            pairAddress: pair.pairAddress,
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || 'Unknown',
            priceUsd: Number(pair.priceUsd) || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            volume24hUsd: pair.volume?.h24 || pair.volume?.h6 || (pair.volume?.h1 ? pair.volume.h1 * 24 : 0) || 0,
            volume5mUsd: pair.volume?.m5 || 0,
            volume30mUsd: (pair.volume?.m5 || 0) + (pair.volume?.h1 ? pair.volume.h1 / 2 : 0),
            priceChange5m: pair.priceChange?.m5 || 0,
            priceChange1h: pair.priceChange?.h1 || 0,
            priceChange6h: pair.priceChange?.h6 || 0,
            txs5m: { buys: pair.txns?.m5?.buys || 0, sells: pair.txns?.m5?.sells || 0 },
            createdAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : undefined,
            updatedAt: new Date(),
            links: {
                dexScreener: pair.url,
                pumpfun: pair.url?.includes('pump') ? pair.url : `https://pump.fun/${tokenAddress}`,
                birdeye: `https://birdeye.so/token/${tokenAddress}?chain=base`
            }
        };
    }

    private chunkArray(arr: string[], size: number): string[][] {
        const res: string[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            res.push(arr.slice(i, i + size));
        }
        return res;
    }
}
