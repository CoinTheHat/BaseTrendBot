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
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    ];

    private getRandomUserAgent() {
        return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    }

    private async makeRequest(url: string): Promise<any> {
        try {
            const response = await axios.get(url, {
                headers: { 'User-Agent': this.getRandomUserAgent() }
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

    /**
     * Fetch latest Solana profiles/pairs.
     * Strategy: Pure Puppeteer Scraping (100 tokens from M5 trending)
     */
    async getLatestPairs(): Promise<TokenSnapshot[]> {
        try {
            console.log(`[DexScreener] Using Puppeteer to scrape 100 tokens from M5 trending...`);

            // Direct scraping - no API profiles
            const scrapedTokens = await this.scrapeTrendingTokens(100);

            console.log(`[DexScreener] Scraped ${scrapedTokens.length} tokens from M5 trending page`);

            return scrapedTokens;

        } catch (error) {
            console.error('[DexScreener] Scraping failed:', error);
            // Fallback: try search API as last resort
            console.log('[DexScreener] Falling back to search API...');
            return (await this.search("solana")).slice(0, 100);
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

        return {
            source: 'dexscreener',
            mint: tokenAddress,
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || 'Unknown',
            priceUsd: Number(pair.priceUsd) || 0,
            marketCapUsd: pair.marketCap || pair.fdv || 0, // Priority: marketCap -> fdv -> 0
            liquidityUsd: pair.liquidity?.usd || 0,
            volume5mUsd: pair.volume?.m5 || 0,
            volume30mUsd: (pair.volume?.m5 || 0) + (pair.volume?.h1 ? pair.volume.h1 / 2 : 0),
            priceChange5m: pair.priceChange?.m5 || 0,
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
    }

    private chunkArray(arr: string[], size: number): string[][] {
        const res: string[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            res.push(arr.slice(i, i + size));
        }
        return res;
    }

    /**
     * Scrape DexScreener's M5 Trending page using Puppeteer
     * https://dexscreener.com/solana?rankBy=trendingScoreM5&order=desc
     * Scrapes full token data directly from pair pages (no API needed)
     */
    private async scrapeTrendingTokens(limit: number = 50): Promise<TokenSnapshot[]> {
        let browser;
        try {
            console.log(`[DexScreener Scraper] Launching browser to scrape ${limit} tokens...`);

            browser = await puppeteer.launch({
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const page = await browser.newPage();
            await page.setUserAgent(this.getRandomUserAgent());

            const url = 'https://dexscreener.com/solana?rankBy=trendingScoreM5&order=desc';
            console.log(`[DexScreener Scraper] Navigating to ${url}...`);

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait for token cards to load
            await page.waitForSelector('a[href^="/solana/"]', { timeout: 10000 });

            // Extract pair URLs
            const pairUrls = await page.evaluate((maxTokens) => {
                const links = Array.from(document.querySelectorAll('a[href^="/solana/"]'));
                const uniqueUrls = new Set<string>();

                for (const link of links) {
                    const href = (link as HTMLAnchorElement).getAttribute('href');
                    if (href && href.match(/^\/solana\/[A-Za-z0-9]+$/)) {
                        uniqueUrls.add('https://dexscreener.com' + href);
                        if (uniqueUrls.size >= maxTokens) break;
                    }
                }

                return Array.from(uniqueUrls);
            }, limit);

            console.log(`[DexScreener Scraper] Found ${pairUrls.length} unique pair URLs`);

            const tokens: TokenSnapshot[] = [];

            // Visit each pair page and scrape data
            for (let i = 0; i < pairUrls.length; i++) {
                try {
                    const pairUrl = pairUrls[i];
                    console.log(`[DexScreener Scraper] [${i + 1}/${pairUrls.length}] Scraping ${pairUrl.split('/').pop()}...`);

                    await page.goto(pairUrl, { waitUntil: 'networkidle2', timeout: 15000 });

                    // Extract all data from pair page
                    const tokenData = await page.evaluate(() => {
                        // Find CA (contract address) - usually in a link or button
                        let ca = '';
                        const caLinks = Array.from(document.querySelectorAll('a[href*="solscan.io"], a[href*="explorer.solana.com"]'));
                        for (const link of caLinks) {
                            const href = (link as HTMLAnchorElement).href;
                            const match = href.match(/address\/([A-Za-z0-9]{32,44})/);
                            if (match) {
                                ca = match[1];
                                break;
                            }
                        }

                        // Fallback: try to find CA in page text or meta tags
                        if (!ca) {
                            const bodyText = document.body.textContent || '';
                            const caMatch = bodyText.match(/[A-Za-z0-9]{32,44}/);
                            ca = caMatch ? caMatch[0] : '';
                        }

                        // Extract metrics from the page (these are usually visible)
                        const getText = (selector: string): string => {
                            const el = document.querySelector(selector);
                            return el?.textContent?.trim() || '';
                        };

                        // Symbol, name are usually in header
                        const headerText = document.querySelector('h1, h2, .pair-header')?.textContent || '';
                        const symbolMatch = headerText.match(/\$([A-Z0-9]+)/);
                        const symbol = symbolMatch ? symbolMatch[1] : 'UNKNOWN';

                        // Try to extract price, liquidity, MC from visible elements
                        // DexScreener shows these prominently
                        const allText = document.body.textContent || '';

                        return {
                            ca,
                            symbol,
                            name: symbol,
                            fullText: allText.substring(0, 5000) // Grab text for parsing
                        };
                    });

                    if (!tokenData.ca || tokenData.ca.length < 32) {
                        console.log(`[DexScreener Scraper] ⚠️ No valid CA found, skipping...`);
                        continue;
                    }

                    // Parse metrics from text (fallback approach)
                    const text = tokenData.fullText;

                    const extractNumber = (pattern: RegExp): number => {
                        const match = text.match(pattern);
                        if (!match) return 0;
                        const numStr = match[1].replace(/[,$]/g, '');
                        return parseFloat(numStr) || 0;
                    };

                    const priceUsd = extractNumber(/Price.*?\$([0-9.]+)/i) || 0;
                    const liquidityUsd = extractNumber(/Liquidity.*?\$([0-9,.]+[KMB]?)/i) || 0;
                    const marketCapUsd = extractNumber(/Market Cap.*?\$([0-9,.]+[KMB]?)/i) || 0;
                    const volume5mUsd = extractNumber(/5m.*?\$([0-9,.]+[KMB]?)/i) || 0;

                    tokens.push({
                        source: 'dexscreener',
                        mint: tokenData.ca,
                        name: tokenData.name,
                        symbol: tokenData.symbol,
                        priceUsd,
                        marketCapUsd,
                        liquidityUsd,
                        volume5mUsd,
                        updatedAt: new Date(),
                        links: {
                            dexScreener: pairUrl,
                            pumpfun: `https://pump.fun/${tokenData.ca}`,
                            birdeye: `https://birdeye.so/token/${tokenData.ca}?chain=solana`
                        }
                    });

                    // Small delay to avoid hammering the server
                    await new Promise(resolve => setTimeout(resolve, 500));

                } catch (error) {
                    console.error(`[DexScreener Scraper] Error scraping pair:`, error);
                }
            }

            await browser.close();

            console.log(`[DexScreener Scraper] Successfully scraped ${tokens.length} tokens`);
            return tokens;

        } catch (error) {
            console.error('[DexScreener Scraper] Error:', error);
            if (browser) await browser.close();
            return [];
        }
    }
}
