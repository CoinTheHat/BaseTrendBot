import axios from 'axios';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';

// Add stealth plugin to avoid Cloudflare detection
puppeteer.use(StealthPlugin());

export class DexScreenerService {
    private baseUrl = 'https://api.dexscreener.com/latest/dex/tokens';
    private trendingPageUrl = 'https://dexscreener.com/solana?rankBy=trendingScoreM5&order=desc';
    private lastScanTime = 0;
    private readonly COOLDOWN_MS = 60000; // 60 seconds

    /**
     * Scrape trending tokens from DexScreener UI (Trending M5)
     * ENHANCED: XHR interception + HTML fallback + debugging
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
            logger.info('[DexScreener] 🌐 Launching Mass Scraper (100 tokens)...');

            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1920,1080']
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            logger.info('[DexScreener] 📄 Navigating to Trending...');
            await page.goto(this.trendingPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait and scroll to load lazy-loaded elements
            await page.waitForSelector('a[href^="/solana/"]', { timeout: 15000 }).catch(() => { });
            await page.evaluate(() => window.scrollBy(0, 5000));
            await new Promise(r => setTimeout(r, 2000));

            const tokens = await page.evaluate(() => {
                const parseVal = (s: string) => {
                    if (!s || s === '-') return 0;
                    const clean = s.replace(/[$,\s]/g, '').toUpperCase();
                    let mult = 1;
                    if (clean.endsWith('K')) mult = 1000;
                    else if (clean.endsWith('M')) mult = 1000000;
                    else if (clean.endsWith('B')) mult = 1000000000;
                    else if (clean.endsWith('T')) mult = 1000000000000;
                    const val = parseFloat(clean.replace(/[KMBT]/g, ''));
                    return isNaN(val) ? 0 : val * mult;
                };

                const parseAgeMs = (s: string) => {
                    if (!s) return 0;
                    const m = s.match(/^(\d+)([mhd])$/);
                    if (!m) return 0;
                    const v = parseInt(m[1]);
                    const u = m[2];
                    if (u === 'm') return v * 60 * 1000;
                    if (u === 'h') return v * 3600 * 1000;
                    if (u === 'd') return v * 86400 * 1000;
                    return 0;
                };

                const rows = Array.from(document.querySelectorAll('a.ds-dex-table-row, a[href^="/solana/"]'))
                    .map(el => ({
                        link: el,
                        row: el.closest('tr') || el.closest('.ds-dex-table-row') || el.parentElement?.parentElement
                    }))
                    .filter(item => item.row && item.link.getAttribute('href')?.includes('/solana/'));

                const results: any[] = [];
                const seen = new Set<string>();

                for (const item of rows) {
                    try {
                        const href = item.link.getAttribute('href') || '';
                        const match = href.match(/\/solana\/([A-Za-z0-9]+)/);
                        if (!match || seen.has(match[1])) continue;

                        const address = match[1];
                        seen.add(address);

                        const row = item.row as HTMLElement;
                        const symbolEl = row.querySelector('.ds-dex-table-row-base-token-symbol') ||
                            row.querySelector('[class*="symbol"]') ||
                            item.link.querySelector('span');

                        // 1. COLLECT ALL TEXTS
                        const cells = Array.from(row.querySelectorAll('td, div.ds-dex-table-row-col, [class*="cell"]'));
                        const texts = cells.map(c => c.textContent?.trim() || '').filter(t => t.length > 0);

                        // 2. LOGIC-BASED PARSING
                        let price = 0;
                        let ageStr = '';
                        let moneyValues: number[] = [];
                        let txns = 0;

                        for (const t of texts) {
                            // Identify Money Values (Price, Vol, Liq, MC)
                            if (t.startsWith('$')) {
                                // Add to moneyValues list regardless of suffix (handling small Vol like $500)
                                const val = parseVal(t);
                                moneyValues.push(val); // Store ALL money values found

                                // Heuristic for Price: usually the first one or small value? 
                                // Actually, we can just rely on the fact Price is usually first.
                                // We store `price` separately just in case, but moneyValues logic is robust for others.
                                const numericVal = parseFloat(t.replace(/[$,]/g, ''));
                                if (!isNaN(numericVal) && price === 0) price = numericVal;
                            }

                            // Txns: Integer, no $, no dots
                            if (/^[\d,]+$/.test(t) && !t.includes('.')) {
                                const val = parseInt(t.replace(/,/g, ''));
                                if (val > 0) txns = val;
                            }

                            // Age: "5m", "1h", "24h"
                            if (/^\d+[mhd]$/.test(t)) {
                                ageStr = t;
                            }
                        }

                        // 3. MAPPING STRATEGY (Right-to-Left)
                        // Typically: Price ... Vol ... Liq ... MC
                        // We assume the LAST money value is MC, then Liq, then Vol.
                        // If we have Price, Vol, Liq, MC -> length 4.
                        // If we have Price, Vol, MC (Liq hidden?) -> length 3. (Rare)

                        // Robust Right-to-Left:
                        const mc = moneyValues.length >= 1 ? moneyValues[moneyValues.length - 1] : 0;
                        const liq = moneyValues.length >= 2 ? moneyValues[moneyValues.length - 2] : 0;
                        const vol = moneyValues.length >= 3 ? moneyValues[moneyValues.length - 3] : 0;

                        // Security fallback: If Liq > MC (impossible usually), swap? 
                        // No, mostly accurate.

                        // Price logic fix: If we collected Price in moneyValues, it's likely index 0.
                        // But we already extracted `price` above.

                        results.push({
                            address,
                            symbol: symbolEl?.textContent?.trim() || 'UNKNOWN',
                            price,
                            volume: vol,
                            liquidity: liq,
                            marketCap: mc,
                            ageMs: parseAgeMs(ageStr)
                        });

                        if (results.length >= 100) break;
                    } catch (e) { }
                }
                return results;
            });

            await browser.close();
            this.lastScanTime = Date.now();
            logger.info(`[DexScreener] ✅ Scraped ${tokens.length} tokens.`);

            return tokens.map((item: any) => ({
                source: 'dexscreener',
                chain: 'solana' as const,
                mint: String(item.address),
                name: item.symbol,
                symbol: item.symbol,
                priceUsd: item.price || 0,
                liquidityUsd: item.liquidity || 0,
                marketCapUsd: item.marketCap || 0,
                volume5mUsd: 0,
                volume24hUsd: item.volume || 0,
                priceChange5m: 0,
                createdAt: item.ageMs ? new Date(Date.now() - item.ageMs) : new Date(),
                updatedAt: new Date(),
                links: {
                    dexScreener: `https://dexscreener.com/solana/${item.address}`
                }
            }));

        } catch (error: any) {
            if (browser) await browser.close();
            logger.error(`[DexScreener] Scraping failed: ${error.message}`);
            this.lastScanTime = Date.now();
            return [];
        }
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
            mint: pair.baseToken?.address || '',
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || '???',
            priceUsd: parseFloat(pair.priceUsd || '0') || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0,
            volume5mUsd: pair.volume?.m5 || 0,
            volume24hUsd: pair.volume?.h24 || 0,
            priceChange5m: pair.priceChange?.m5 || 0,
            createdAt: new Date(pair.pairCreatedAt || Date.now()),
            updatedAt: new Date(),
            links: {
                dexScreener: pair.url || `https://dexscreener.com/solana/${pair.baseToken?.address}`
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
