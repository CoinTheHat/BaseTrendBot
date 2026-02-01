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
     * Strategy: Combine Profiles + Search to get ~100 tokens
     */
    async getLatestPairs(): Promise<TokenSnapshot[]> {
        try {
            const allTokens: TokenSnapshot[] = [];

            // Strategy 1: Use Token Profiles endpoint (usually ~30 tokens)
            const data = await this.makeRequest(this.profilesUrl);
            const profiles = data || [];

            const solanaProfiles = profiles.filter((p: any) => p.chainId === 'solana');

            if (solanaProfiles.length > 0) {
                console.log(`[DexScreener] Found ${solanaProfiles.length} new Solana profiles.`);
                const mints = solanaProfiles.map((p: any) => p.tokenAddress);
                const profileTokens = await this.getTokens(mints);
                allTokens.push(...profileTokens);
            }

            // Strategy 2: Supplement with Search to reach ~100 total tokens
            // Search for fresh Solana tokens using multiple queries
            const searchQueries = ['solana', 'sol meme', 'pump'];

            for (const query of searchQueries) {
                if (allTokens.length >= 100) break; // Stop if we have 100

                const searchResults = await this.search(query);

                // Add only unique tokens (not already in allTokens)
                const uniqueResults = searchResults.filter(
                    (sr: TokenSnapshot) => !allTokens.some(at => at.mint === sr.mint)
                );

                allTokens.push(...uniqueResults);

                // Small delay between searches to avoid rate limit
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Limit to 100 tokens
            const finalTokens = allTokens.slice(0, 100);

            console.log(`[DexScreener] API fetched: ${finalTokens.length} tokens`);

            // Strategy 3: If still under 100, use Puppeteer scraping to fill the gap
            if (finalTokens.length < 100) {
                console.log(`[DexScreener] Using Puppeteer scraping to reach 100 tokens...`);
                const scrapedTokens = await this.scrapeTrendingTokens(100 - finalTokens.length);

                // Add unique scraped tokens
                const uniqueScraped = scrapedTokens.filter(
                    st => !finalTokens.some(ft => ft.mint === st.mint)
                );

                finalTokens.push(...uniqueScraped);
                console.log(`[DexScreener] Added ${uniqueScraped.length} scraped tokens. Total: ${finalTokens.length}`);
            }

            return finalTokens.slice(0, 100);

        } catch (error) {
            console.error('[DexScreener] Error fetching latest profiles:', error);
            // Fallback on error - just search
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
                const data = await this.makeRequest(url);
                const pairs = data?.pairs || [];

                // Strict filtering is done inside normalizePair
                const validPairs = pairs
                    .map((p: any) => this.normalizePair(p))
                    .filter((p: TokenSnapshot | null): p is TokenSnapshot => p !== null);

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

            // Extract token data from the page
            const tokens = await page.evaluate((maxTokens) => {
                const tokenLinks = Array.from(document.querySelectorAll('a[href^="/solana/"]'));
                const results: any[] = [];

                for (let i = 0; i < Math.min(tokenLinks.length, maxTokens); i++) {
                    const link = tokenLinks[i] as HTMLAnchorElement;
                    const card = link.closest('div');

                    if (!card) continue;

                    // Extract token address from href
                    const href = link.getAttribute('href') || '';
                    const match = href.match(/\/solana\/([A-Za-z0-9]+)/);
                    if (!match) continue;

                    const tokenAddress = match[1];

                    // Extract text content (symbol, price, liquidity, etc.)
                    const textContent = card.textContent || '';

                    // Try to extract basic info (this is a best-effort approach)
                    results.push({
                        tokenAddress,
                        textContent: textContent.substring(0, 200) // Limit text for safety
                    });
                }

                return results;
            }, limit);

            console.log(`[DexScreener Scraper] Scraped ${tokens.length} tokens from page`);

            // Convert to TokenSnapshot format
            // Get full details using API for these tokens
            const mints = tokens.map((t: any) => t.tokenAddress).filter(Boolean);
            const fullTokenData = await this.getTokens(mints);

            await browser.close();

            return fullTokenData;

        } catch (error) {
            console.error('[DexScreener Scraper] Error:', error);
            if (browser) await browser.close();
            return [];
        }
    }
}
