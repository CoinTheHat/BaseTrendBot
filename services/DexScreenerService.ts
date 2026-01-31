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
            logger.info('[DexScreener] 🌐 Launching browser...');

            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1920,1080']
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

            await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));

            logger.info('[DexScreener] 📄 Navigating...');
            await page.goto(this.trendingPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            logger.info('[DexScreener] ⏳ Waiting for links...');
            await page.waitForSelector('a[href^="/solana/"]', { timeout: 15000 });
            await new Promise(r => setTimeout(r, 2000));

            await page.screenshot({ path: 'debug-dexscreener.png' });
            logger.info('[DexScreener] 📸 Screenshot saved');

            const tokens = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href^="/solana/"]'));
                const results: any[] = [];
                const seen = new Set<string>();

                for (const link of links.slice(0, 30)) {
                    try {
                        const href = link.getAttribute('href') || '';
                        const match = href.match(/\/solana\/([A-Za-z0-9]+)/);
                        if (!match) continue;

                        const address = match[1];
                        if (seen.has(address)) continue;
                        seen.add(address);

                        const row = link.closest('tr') || link.closest('[class*="table-row"]') || link.parentElement?.parentElement;
                        if (!row) continue;

                        const symbolEl = row.querySelector('[class*="symbol"]') || link.querySelector('span');
                        const symbol = symbolEl?.textContent?.trim() || 'UNKNOWN';

                        // Extract all cell texts
                        const cells = Array.from(row.querySelectorAll('td, [class*="cell"]'));
                        const cellTexts = cells.map(c => c.textContent?.trim() || '');

                        // Parse liquidity
                        let liquidity = 0;
                        for (const text of cellTexts) {
                            if (text.includes('$') && (text.includes('K') || text.includes('M'))) {
                                const clean = text.replace(/[^0-9.KM]/g, '');
                                if (clean.includes('K')) {
                                    liquidity = parseFloat(clean.replace('K', '')) * 1000;
                                } else if (clean.includes('M')) {
                                    liquidity = parseFloat(clean.replace('M', '')) * 1000000;
                                }
                                if (liquidity > 1000) break;
                            }
                        }

                        // Parse volume
                        let volume24h = 0;
                        for (const text of cellTexts) {
                            if (text.includes('$') && text.length < 20) {
                                const clean = text.replace(/[^0-9.KM]/g, '');
                                if (clean.includes('K')) {
                                    const val = parseFloat(clean.replace('K', '')) * 1000;
                                    if (val > volume24h) volume24h = val;
                                } else if (clean.includes('M')) {
                                    const val = parseFloat(clean.replace('M', '')) * 1000000;
                                    if (val > volume24h) volume24h = val;
                                }
                            }
                        }

                        // Parse price
                        let price = 0;
                        for (const text of cellTexts) {
                            if (text.startsWith('$') && text.includes('.')) {
                                const priceMatch = text.match(/\$([0-9.]+)/);
                                if (priceMatch) {
                                    const p = parseFloat(priceMatch[1]);
                                    if (p > 0 && p < 1000) {
                                        price = p;
                                        break;
                                    }
                                }
                            }
                        }

                        results.push({ address, symbol, liquidity, volume24h, price });
                    } catch { }
                }
                return results;
            });

            await browser.close();
            this.lastScanTime = Date.now();

            logger.info(`[DexScreener] Found ${tokens.length} tokens`);

            if (tokens.length === 0) {
                logger.error('[DexScreener] ⚠️ ZERO TOKENS! Check debug-dexscreener.png');
                return [];
            }

            return tokens.map((item: any) => ({
                source: 'dexscreener',
                chain: 'solana' as const,
                mint: String(item.address),
                name: item.symbol,
                symbol: item.symbol,
                priceUsd: item.price || 0,
                liquidityUsd: item.liquidity || 0,
                marketCapUsd: 0, // Can calculate from price if needed
                volume5mUsd: 0, // Not available from table
                volume24hUsd: item.volume24h || 0,
                priceChange5m: 0, // Not easily parseable
                createdAt: new Date(),
                updatedAt: new Date(),
                links: {
                    dexScreener: `https://dexscreener.com/solana/${item.address}`
                }
            }));

        } catch (error: any) {
            if (browser) await browser.close();
            logger.error(`[DexScreener] Error: ${error.message}`);
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
