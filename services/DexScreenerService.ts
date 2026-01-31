import axios from 'axios';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';

export class DexScreenerService {
    private baseUrl = 'https://api.dexscreener.com/latest/dex/tokens';
    private trendingUrl = 'https://api.dexscreener.com/token-profiles/latest/v1';
    private lastScanTime = 0;
    private readonly COOLDOWN_MS = 60000; // 60 seconds

    /**
     * Fetch trending tokens from DexScreener (5-minute momentum)
     * CRITICAL: Returns normalized addresses (.toString()) for BirdEye compatibility
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

        try {
            const response = await axios.get(this.trendingUrl, { timeout: 10000 });
            this.lastScanTime = Date.now();

            if (!response.data || !Array.isArray(response.data)) {
                logger.error('[DexScreener] Invalid response format from M5 trending');
                return [];
            }

            // Filter for Solana tokens with good metrics
            const candidates = response.data.filter((item: any) => {
                return (
                    item.chainId === 'solana' &&
                    item.trendingScoreM5 && item.trendingScoreM5 > 0 &&
                    item.volume?.m5 && item.volume.m5 > 5000 &&
                    item.liquidity?.usd && item.liquidity.usd > 5000
                );
            });

            // Sort by trendingScoreM5 descending
            candidates.sort((a: any, b: any) => (b.trendingScoreM5 || 0) - (a.trendingScoreM5 || 0));

            // Take top 20
            const topTokens = candidates.slice(0, 20);

            logger.info(`[DexScreener M5] Found ${topTokens.length} trending tokens (from ${response.data.length} total)`);

            return topTokens.map((item: any) => ({
                source: 'dexscreener',
                chain: 'solana' as const,
                mint: String(item.tokenAddress || item.baseToken?.address || ''), // NORMALIZED with String()
                name: item.baseToken?.name || item.name || 'Unknown',
                symbol: item.baseToken?.symbol || item.symbol || '???',
                priceUsd: parseFloat(item.priceUsd || '0') || 0,
                liquidityUsd: item.liquidity?.usd || 0,
                marketCapUsd: item.marketCap || item.fdv || 0,
                volume5mUsd: item.volume?.m5 || 0,
                volume24hUsd: item.volume?.h24 || 0,
                priceChange5m: item.priceChange?.m5 || 0,
                createdAt: new Date(item.pairCreatedAt || Date.now()),
                updatedAt: new Date(),
                links: {
                    dexScreener: item.url || `https://dexscreener.com/solana/${item.tokenAddress || ''}`
                }
            }));

        } catch (error: any) {
            logger.error(`[DexScreener M5] Error: ${error.message}`);
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
