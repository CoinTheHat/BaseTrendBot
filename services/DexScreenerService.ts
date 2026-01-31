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
     * CRITICAL: Scrapes the actual website to get real-time trending data
     * Returns normalized addresses (.toString()) for BirdEye compatibility
     * Includes 60-second cooldown to prevent rate limiting
     */
    async fetchTrendingM5(): Promise<TokenSnapshot[]> {
        // Enforce cooldown
        const now = Date.now();
        const timeSinceLastScan = now - this.lastScanTime;
        if (timeSinceLastScan < this.COOLDOWN_MS) {
            const waitTime = Math.ceil((this.COOLDOWN_MS - timeSinceLastScan) / 1000);
            logger.warn(`[DexScreener] Cooldown active. Wait ${waitTime}s before next scan.`);
            return [];
        }

        let browser;
        try {
            logger.info('[DexScreener] 🌐 Launching browser for UI scraping...');

            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
            });

            const page = await browser.newPage();

            // Set realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // Random delay to appear more human
            const randomDelay = Math.floor(Math.random() * 2000) + 1000; // 1-3s
            await new Promise(r => setTimeout(r, randomDelay));

            logger.info(`[DexScreener] 📄 Navigate to: ${this.trendingPageUrl}`);
            await page.goto(this.trendingPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait for table to load
            await page.waitForSelector('.ds-dex-table-row', { timeout: 15000 });

            logger.info('[DexScreener] 🔍 Scraping trending tokens...');

            // Extract token data from table rows
            const tokens = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('.ds-dex-table-row'));
                const results: any[] = [];

                for (const row of rows.slice(0, 30)) { // Top 30 tokens
                    try {
                        // Extract token address from link
                        const linkElement = row.querySelector('a[href*="/solana/"]');
                        if (!linkElement) continue;

                        const href = linkElement.getAttribute('href') || '';
                        const addressMatch = href.match(/\/solana\/([A-Za-z0-9]+)/);
                        if (!addressMatch) continue;

                        const address = addressMatch[1];

                        // Extract symbol
                        const symbolElement = row.querySelector('.ds-dex-table-row-col-token .ds-table-data-cell-main-value');
                        const symbol = symbolElement?.textContent?.trim() || 'UNKNOWN';

                        // Extract price change M5
                        const priceChangeElements = row.querySelectorAll('.ds-table-data-cell-minor-value');
                        let priceChangeM5 = 0;
                        if (priceChangeElements.length > 0) {
                            const text = priceChangeElements[0].textContent?.trim() || '0';
                            priceChangeM5 = parseFloat(text.replace('%', '').replace('+', ''));
                        }

                        // Extract volume M5 (approximate from text)
                        const volumeElements = row.querySelectorAll('.ds-table-data-cell-minor-value');
                        let volumeM5 = 0;
                        if (volumeElements.length > 1) {
                            const volText = volumeElements[1].textContent?.trim() || '0';
                            // Parse volume like "$12.5K" or "$1.2M"
                            if (volText.includes('K')) {
                                volumeM5 = parseFloat(volText.replace('$', '').replace('K', '')) * 1000;
                            } else if (volText.includes('M')) {
                                volumeM5 = parseFloat(volText.replace('$', '').replace('M', '')) * 1000000;
                            }
                        }

                        results.push({
                            address,
                            symbol,
                            priceChangeM5,
                            volumeM5
                        });
                    } catch (err) {
                        // Skip this row, continue
                    }
                }

                return results;
            });

            await browser.close();
            this.lastScanTime = Date.now();

            logger.info(`[DexScreener UI] Found ${tokens.length} trending tokens`);

            // Convert to TokenSnapshot format
            return tokens.map((item: any) => ({
                source: 'dexscreener',
                chain: 'solana' as const,
                mint: String(item.address), // NORMALIZED with String()
                name: item.symbol,
                symbol: item.symbol,
                priceUsd: 0, // Will be fetched from BirdEye
                liquidityUsd: 0, // Will be fetched from BirdEye
                marketCapUsd: 0, // Will be fetched from BirdEye
                volume5mUsd: item.volumeM5,
                volume24hUsd: 0,
                priceChange5m: item.priceChangeM5,
                createdAt: new Date(),
                updatedAt: new Date(),
                links: {
                    dexScreener: `https://dexscreener.com/solana/${item.address}`
                }
            }));

        } catch (error: any) {
            if (browser) await browser.close();
            logger.error(`[DexScreener UI] Scraping error: ${error.message}`);
            this.lastScanTime = Date.now(); // Still update to prevent hammering on errors
            return [];
        }
    }

    /**
     * Fetch tokens from DexScreener (Free API)
     * Limit: 30 addresses per call (approx)
     */
    async getTokens(mints: string[]): Promise<TokenSnapshot[]> {
        if (!mints.length) return [];

        // Chunking to handle URL length limits
        const chunks = this.chunkArray(mints, 30);
        const allTokens: TokenSnapshot[] = [];

        for (const chunk of chunks) {
            try {
                const url = `${this.baseUrl}/${chunk.join(',')}`;
                const response = await axios.get(url, { timeout: 10000 });

                if (!response.data || !response.data.pairs) continue;

                const pairs = response.data.pairs;
                // DexScreener returns pairs, we need to map to our TokenSnapshot format.
                // One mint might have multiple pairs. We usually want the most liquid one or aggregate.
                // Strategy: Take the pair with highest liquidity for each unique baseToken.address

                // Group by mint
                const bestPairs: Record<string, any> = {};

                for (const pair of pairs) {
                    const mint = pair.baseToken.address;
                    if (!bestPairs[mint] || pair.liquidity.usd > bestPairs[mint].liquidity.usd) {
                        bestPairs[mint] = pair;
                    }
                }

                const snapshots = Object.values(bestPairs).map((pair: any) => this.mapPairToSnapshot(pair));
                allTokens.push(...snapshots);

            } catch (error: any) {
                logger.error(`[DexScreener] Error fetching chunk: ${error.message}`);
            }
        }

        return allTokens;
    }

    private mapPairToSnapshot(pair: any): TokenSnapshot {
        return {
            source: 'dexscreener',
            chain: pair.chainId === 'solana' ? 'solana' : (pair.chainId === 'base' ? 'base' : undefined),
            mint: pair.baseToken.address,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0, // DexScreener uses FDV often as MC
            volume5mUsd: pair.volume?.m5 || 0,
            volume30mUsd: pair.volume?.h1 / 2 || 0, // Approx
            volume24hUsd: pair.volume?.h24 || 0,
            createdAt: new Date(pair.pairCreatedAt || Date.now()),
            updatedAt: new Date(),
            links: {
                dexScreener: pair.url
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
