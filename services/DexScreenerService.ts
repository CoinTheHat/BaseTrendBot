import axios from 'axios';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';

export class DexScreenerService {
    private baseUrl = 'https://api.dexscreener.com/latest/dex/tokens';

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
