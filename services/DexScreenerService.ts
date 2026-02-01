import axios from 'axios';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';

// Add stealth plugin to avoid Cloudflare detection
puppeteer.use(StealthPlugin());

export class DexScreenerService {
    private baseUrl = 'https://api.dexscreener.com/latest/dex/tokens';
    private pairsUrl = 'https://api.dexscreener.com/latest/dex/pairs/solana';
    private trendingPageUrl = 'https://dexscreener.com/solana?rankBy=trendingScoreM5&order=desc';
    private lastScanTime = 0;
    private readonly COOLDOWN_MS = 60000; // 60 seconds

    /**
     * Scrape trending tokens from DexScreener UI (Trending M5)
     * ENHANCED: Scrape Pair Addresses -> Resolve to Token Mints via API
     */
    async fetchTrendingM5(): Promise<TokenSnapshot[]> {
        const now = Date.now();
        const timeSinceLastScan = now - this.lastScanTime;
        if (timeSinceLastScan < this.COOLDOWN_MS) {
            const waitTime = Math.ceil((this.COOLDOWN_MS - timeSinceLastScan) / 1000);
            logger.warn(`[DexScreener] Cooldown active. Wait ${waitTime}s`);
            return [];
        }

        let browser;
        try {
            logger.info('[DexScreener] 🌐 Launching Mass Scraper (50+ tokens)...');

            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1920,1080']
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            logger.info('[DexScreener] 📄 Navigating to Trending...');
            await page.goto(this.trendingPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait and scroll to load lazy-loaded elements (MORE SCROLL FOR 50+ TOKENS)
            await page.waitForSelector('a[href^="/solana/"]', { timeout: 15000 }).catch(() => { });
            await page.evaluate(() => window.scrollBy(0, 5000));
            await new Promise(r => setTimeout(r, 2000));
            await page.evaluate(() => window.scrollBy(0, 5000)); // Extra scroll
            await new Promise(r => setTimeout(r, 2000));

            // EXTERNALLY SCRAPE PAIR ADDRESSES ONLY
            const pairAddresses = await page.evaluate(() => {
                const seen = new Set<string>();
                const addresses: string[] = [];

                const links = Array.from(document.querySelectorAll('a[href^="/solana/"]'));
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    const match = href.match(/\/solana\/([A-Za-z0-9]+)/);
                    if (match && !seen.has(match[1])) {
                        seen.add(match[1]);
                        addresses.push(match[1]);
                    }
                    if (addresses.length >= 80) break; // Fetch 80 pairs to get ~50 valid tokens
                }
                return addresses;
            });

            await browser.close();
            this.lastScanTime = Date.now();

            if (pairAddresses.length === 0) {
                logger.warn('[DexScreener] No pairs found on page.');
                return [];
            }

            logger.info(`[DexScreener] Found ${pairAddresses.length} pairs. Resolving to Tokens via API...`);

            // RESOLVE PAIRS TO TOKENS VIA API
            const tokens = await this.getPairs(pairAddresses);
            logger.info(`[DexScreener] ✅ Resolved ${tokens.length} valid tokens.`);
            return tokens;

        } catch (error: any) {
            if (browser) await browser.close();
            logger.error(`[DexScreener] Scraping failed: ${error.message}`);
            this.lastScanTime = Date.now();
            return [];
        }
    }

    // NEW: Fetch Pair Data to get Base Token Address (Real CA)
    async getPairs(pairAddresses: string[]): Promise<TokenSnapshot[]> {
        if (pairAddresses.length === 0) return [];

        const chunks = this.chunkArray(pairAddresses, 30); // Max 30 per call usually safe
        const allTokens: TokenSnapshot[] = [];

        for (const chunk of chunks) {
            try {
                // Endpoint: /latest/dex/pairs/solana/pair1,pair2
                const url = `${this.pairsUrl}/${chunk.join(',')}`;
                const response = await axios.get(url, { timeout: 10000 });

                if (response.data?.pairs) {
                    const mapped = response.data.pairs.map((pair: any) => this.mapPairToSnapshot(pair));
                    allTokens.push(...mapped);
                }
            } catch (err: any) {
                logger.warn(`[DexScreener] API Pair fetch failed: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 200));
        }

        return allTokens;
    }

    async getTokens(mints: string[]): Promise<TokenSnapshot[]> {
        if (mints.length === 0) return [];

        const chunks = this.chunkArray(mints, 30);
        const allTokens: TokenSnapshot[] = [];

        for (const chunk of chunks) {
            try {
                const url = `${this.baseUrl}/${chunk.join(',')}`;
                const response = await axios.get(url, { timeout: 10000 });

                if (response.data?.pairs) {
                    const mapped = response.data.pairs.map((pair: any) => this.mapPairToSnapshot(pair));
                    allTokens.push(...mapped);
                }
            } catch {
                logger.warn(`[DexScreener] Batch fetch failed for ${chunk.length} tokens`);
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        return allTokens;
    }

    private mapPairToSnapshot(pair: any): TokenSnapshot {
        return {
            source: 'dexscreener',
            chain: 'solana',
            mint: pair.baseToken?.address || '', // <--- THIS IS THE FIX (Actual CA)
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || '???',
            priceUsd: parseFloat(pair.priceUsd || '0') || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0,
            volume5mUsd: pair.volume?.m5 || 0,
            volume24hUsd: pair.volume?.h24 || 0,
            priceChange5m: pair.priceChange?.m5 || 0,
            txs5m: pair.txns?.m5 || { buys: 0, sells: 0 },
            createdAt: new Date(pair.pairCreatedAt || Date.now()),
            updatedAt: new Date(),
            links: {
                dexScreener: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`, // Link to Pair usually
                birdeye: `https://birdeye.so/token/${pair.baseToken?.address}?chain=solana`,
                pumpfun: pair.baseToken?.address?.endsWith('pump') ? `https://pump.fun/${pair.baseToken?.address}` : undefined
            }
        };
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        const res: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            res.push(arr.slice(i, i + size));
        }
        return res;
    }
}
