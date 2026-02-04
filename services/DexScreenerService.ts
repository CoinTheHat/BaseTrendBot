import axios from 'axios';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { TokenSnapshot } from '../models/types';

puppeteer.use(StealthPlugin());

export class DexScreenerService {
    private apiUrl = 'https://api.dexscreener.com/latest/dex';
    private profilesUrl = 'https://api.dexscreener.com/token-profiles/latest/v1'; // Check docs for actual latest-token endpoints

    /**
     * Fetch latest Solana profiles/pairs.
     * DexScreener API is versatile. We might use `search` or specific specialized endpoints.
     * For this V1, we will assume we want to search for 'Solana' new pairs or similar.
     */
    private userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    ];

    private getRandomUserAgent() {
        return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    }

    private async makeRequest(url: string): Promise<any> {
        try {
            // CACHE BUSTING: Add timestamp and headers to force fresh data (User Request: Prevent stale dump data)
            const separator = url.includes('?') ? '&' : '?';
            const freshUrl = `${url}${separator}t=${Date.now()}`;

            const response = await axios.get(freshUrl, {
                headers: {
                    'User-Agent': this.getRandomUserAgent(),
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            });
            return response.data;
        } catch (error: any) {
            if (error.response?.status === 429) {
                console.warn('[DexScreener] 🚨 Rate Limit! 60 saniye soğumaya alınıyor...');
                await new Promise(resolve => setTimeout(resolve, 60000));
                return null; // Return null to indicate skip
            }
            throw error;
        }
    }

    // ... (rest of methods)



    /**
     * Fetch latest Solana profiles/pairs.
     * Strategy: Scrape 100 pair addresses from M5 trending, then fetch full data via API.
     * This is fast (1 page load) and 100% accurate (API metrics).
     */
    async getLatestPairs(): Promise<TokenSnapshot[]> {
        try {
            console.log(`[DexScreener] Scraping 150 pair addresses from M5 trending to ensure 100 candidate buffer...`);

            // 1. Get 150 pair addresses from the trending page (Buffer for API filtering)
            const pairAddresses = await this.scrapePairAddresses(150);

            if (pairAddresses.length === 0) {
                console.log(`[DexScreener] Found 0 pairs via scraping. Falling back to search...`);
                return (await this.search("solana")).slice(0, 100);
            }

            console.log(`[DexScreener] Found ${pairAddresses.length} pairs. Fetching full data via API...`);

            // 2. Fetch full data for these pairs (API supports bulk pair lookup)
            const results: TokenSnapshot[] = [];
            const chunks = this.chunkArray(pairAddresses, 30);

            for (const chunk of chunks) {
                try {
                    const url = `${this.apiUrl}/pairs/solana/${chunk.join(',')}`;
                    const data = await this.makeRequest(url);
                    const pairs = data?.pairs || [];

                    const validTokens = pairs
                        .map((p: any) => this.normalizePair(p))
                        .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null);

                    results.push(...validTokens);
                } catch (err) {
                    console.error(`[DexScreener] Error fetching pair chunk:`, err);
                }
            }

            console.log(`[DexScreener] Successfully retrieved ${results.length} tokens with accurate metrics`);
            return results.slice(0, 100);

        } catch (error) {
            console.error('[DexScreener] Hybrid fetching failed:', error);
            return [];
        }
    }


    /**
     * Get specific token data by Mint Address(es)
     */
    async getTokens(mints: string[]): Promise<TokenSnapshot[]> {
        if (mints.length === 0) return [];

        // DexScreener allows up to 30 addresses per call
        const chunks = this.chunkArray(mints, 30);
        const results: TokenSnapshot[] = [];

        for (const chunk of chunks) {
            try {
                const url = `${this.apiUrl}/tokens/${chunk.join(',')}`;
                console.log(`[DexScreener API] Requesting ${chunk.length} tokens...`);

                const data = await this.makeRequest(url);
                const pairs = data?.pairs || [];

                console.log(`[DexScreener API] Received ${pairs.length} pairs from API`);

                // Strict filtering is done inside normalizePair
                const validPairs = pairs
                    .map((p: any) => this.normalizePair(p))
                    .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null);

                console.log(`[DexScreener API] After filtering: ${validPairs.length} valid tokens`);

                results.push(...validPairs);

            } catch (error) {
                console.error(`[DexScreener] Error fetching tokens chunk:`, error);
            }
        }

        return results;
    }

    async search(query: string): Promise<TokenSnapshot[]> {
        try {
            // Encode query to avoid issues
            const safeQuery = encodeURIComponent(query);
            const data = await this.makeRequest(`${this.apiUrl}/search?q=${safeQuery}`);
            const pairs = data?.pairs || []; // If rate limited (null), pairs is []

            // Strict filtering via normalizePair
            return pairs
                .map((p: any) => this.normalizePair(p))
                .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null);
        } catch (error) {
            console.error(`[DexScreener] Search failed for '${query}':`, error);
            return [];
        }
    }

    private normalizePair(pair: any): TokenSnapshot | null {
        // Strict Filtering: Chain ID must be 'solana'
        if (pair?.chainId !== 'solana') {
            return null;
        }

        // Strict Filtering: Block 0x... addresses (Base/ETH)
        // Usually dexScreener returns token objects.
        const tokenAddress = pair.baseToken?.address || '';
        if (tokenAddress.startsWith('0x')) {
            return null;
        }

        const result: TokenSnapshot = {
            source: 'dexscreener',
            mint: tokenAddress,
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || 'Unknown',
            priceUsd: Number(pair.priceUsd) || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0, // Priority: marketCap -> fdv -> 0
            liquidityUsd: pair.liquidity?.usd || 0,
            volume24hUsd: pair.volume?.h24 || pair.volume?.h6 || (pair.volume?.h1 ? pair.volume.h1 * 24 : 0) || 0,
            volume5mUsd: pair.volume?.m5 || 0,
            volume30mUsd: (pair.volume?.m5 || 0) + (pair.volume?.h1 ? pair.volume.h1 / 2 : 0),
            priceChange5m: pair.priceChange?.m5 || 0,
            priceChange1h: pair.priceChange?.h1 || 0,
            priceChange6h: pair.priceChange?.h6 || 0,
            txs5m: {
                buys: pair.txns?.m5?.buys || 0,
                sells: pair.txns?.m5?.sells || 0
            },
            createdAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : undefined,
            updatedAt: new Date(),
            links: {
                dexScreener: pair.url,
                pumpfun: pair.url?.includes('pump') ? pair.url : `https://pump.fun/${tokenAddress}`,
                birdeye: `https://birdeye.so/token/${tokenAddress}?chain=solana`
            }
        };

        return result;
    }

    private chunkArray(arr: string[], size: number): string[][] {
        const res: string[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            res.push(arr.slice(i, i + size));
        }
        return res;
    }

    // --- PERSISTENT BROWSER LOGIC ---
    private browser: any | null = null;
    private scanCount = 0;
    private MAX_SCANS_BEFORE_RECYCLE = 50;

    /**
     * Initializes or reuses the browser instance.
     * Implements "Recycling" strategy to prevent memory leaks.
     */
    private async getBrowser(): Promise<any> {
        // 1. Check Recycle Condition
        if (this.browser && this.scanCount >= this.MAX_SCANS_BEFORE_RECYCLE) {
            console.log(`[DexScreener] ♻️ Recycling browser after ${this.scanCount} scans...`);
            await this.closeBrowser();
        }

        // 2. Launch if needed
        if (!this.browser) {
            /*console.log(`[DexScreener] 🚀 Launching persistent browser...`);*/
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--mute-audio'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            });
            this.scanCount = 0;
        }

        return this.browser;
    }

    private async closeBrowser() {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (e) {
                console.error('[DexScreener] Error closing browser during recycle:', e);
            }
            this.browser = null;
            this.scanCount = 0;
        }
    }

    /**
     * Scrape DexScreener's M5 Trending page to get pair addresses
     * https://dexscreener.com/solana?rankBy=trendingScoreM5&order=desc
     * NOW OPTIMIZED: Reuses browser instance.
     */
    private async scrapePairAddresses(limit: number = 100): Promise<string[]> {
        let page;
        try {
            // console.log(`[DexScreener Scraper] Reuse browser (Scan #${this.scanCount + 1})...`);

            const browser = await this.getBrowser();
            this.scanCount++;

            // Use verify-clean context (Incognito) - lightweight for each page
            try {
                // Try reuse existing pages if we want extreme speed, but newContext is safer for "Clean State"
                // Just create new PAGE, not context (Context creation is also cheaper than browser but let's stick to standard Page for now)
                page = await browser.newPage();
            } catch (err) {
                // If browser crashed or disconnected, restart it
                console.warn('[DexScreener] Browser disconnected? Restarting...');
                await this.closeBrowser();
                const newBrowser = await this.getBrowser();
                page = await newBrowser.newPage();
            }

            // Resource Blocking (User Request)
            await page.setRequestInterception(true);
            page.on('request', (req: any) => {
                const type = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media', 'other'].includes(type)) { // Block 'other' too? be careful.
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.setUserAgent(this.getRandomUserAgent());

            // DISABLE CACHE
            await page.setCacheEnabled(false);

            const url = 'https://dexscreener.com/solana?rankBy=trendingScoreM5&order=desc';

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // Reduced timeout

            // Wait for token cards/rows to load
            try {
                await page.waitForSelector('a[href^="/solana/"]', { timeout: 8000 });
            } catch (e) {
                console.warn('[DexScreener] Timeout waiting for selector. Page might be empty.');
            }

            // Extract pair addresses from hrefs
            const pairAddresses = await page.evaluate((maxPairs: number) => {
                const links = Array.from(document.querySelectorAll('a[href^="/solana/"]'));
                const addresses = new Set<string>();

                for (const link of links) {
                    const href = (link as HTMLAnchorElement).getAttribute('href') || '';
                    const match = href.match(/^\/solana\/([A-Za-z0-9]+)$/);
                    if (match && match[1]) {
                        addresses.add(match[1]);
                        if (addresses.size >= maxPairs) break;
                    }
                }

                return Array.from(addresses);
            }, limit);

            // console.log(`[DexScreener Scraper] Extracted ${pairAddresses.length} addresses.`);

            return pairAddresses;

        } catch (error) {
            console.error('[DexScreener Scraper] Error scraping addresses:', error);
            // If critical error, maybe close browser to be safe
            // await this.closeBrowser();
            return [];
        } finally {
            if (page) {
                try {
                    await page.close(); // Close only the page/tab!
                } catch (closeError) {
                    console.error('[DexScreener Scraper] Error closing page:', closeError);
                }
            }
        }
    }
}
