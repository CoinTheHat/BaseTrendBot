import axios from 'axios';
import { TokenSnapshot } from '../models/types';

export class DexScreenerService {
    private apiUrl = 'https://api.dexscreener.com/latest/dex';
    private profilesUrl = 'https://api.dexscreener.com/token-profiles/latest/v1'; // Check docs for actual latest-token endpoints

    /**
     * Fetch latest Solana profiles/pairs.
     * DexScreener API is versatile. We might use `search` or specific specialized endpoints.
     * For this V1, we will assume we want to search for 'Solana' new pairs or similar.
     */
    async getLatestPairs(): Promise<TokenSnapshot[]> {
        try {
            // V1 Strategy: Use search to find active Solana pairs since strict "latest" needs specific setup
            const response = await axios.get(`${this.apiUrl}/search?q=solana`);
            const pairs = response.data?.pairs || [];

            // Filter for Solana chain to be sure
            const solPairs = pairs.filter((p: any) => p.chainId === 'solana');

            console.log(`[DexScreener] Fetched ${solPairs.length} active pairs.`);

            return solPairs.map((p: any) => this.normalizePair(p));
        } catch (error) {
            console.error('[DexScreener] Error fetching pairs:', error);
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
                const response = await axios.get(url);
                const pairs = response.data?.pairs || [];

                // Filter for Solana pairs specifically
                const solPairs = pairs.filter((p: any) => p.chainId === 'solana');

                solPairs.forEach((p: any) => {
                    results.push(this.normalizePair(p));
                });

            } catch (error) {
                console.error(`[DexScreener] Error fetching tokens chunk:`, error);
            }
        }

        return results;
    }

    private normalizePair(pair: any): TokenSnapshot {
        return {
            source: 'dexscreener',
            mint: pair.baseToken.address,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            priceUsd: Number(pair.priceUsd) || 0,
            marketCapUsd: pair.fdv || 0, // FDV is often close to MC for fully minted memes
            liquidityUsd: pair.liquidity?.usd || 0,
            volume5mUsd: pair.volume?.m5 || 0,
            volume30mUsd: (pair.volume?.m5 || 0) + (pair.volume?.h1 ? pair.volume.h1 / 2 : 0), // rough approx if 30m not explicit
            // DexScreener doesn't always avail buyers count in public API v1
            createdAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : undefined,
            updatedAt: new Date(),
            links: {
                dexScreener: pair.url
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
