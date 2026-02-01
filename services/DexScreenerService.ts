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
     */
    async getLatestPairs(): Promise<TokenSnapshot[]> {
        try {
            // Strategy: Use Token Profiles endpoint to get truly NEW tokens
            const data = await this.makeRequest(this.profilesUrl);
            const profiles = data || []; // Handle null/empty

            // 1. Strict Chain Filtering
            const solanaProfiles = profiles.filter((p: any) => p.chainId === 'solana');

            if (solanaProfiles.length === 0) {
                // If profiles failed/empty (or rate limited returned null -> empty arr), fallback.
                console.log(`[DexScreener] 0 profiles/RateLimit. Switching to fallback search...`);

                // Fallback 1: Search "solana"
                return await this.search("solana");
            }

            console.log(`[DexScreener] Found ${solanaProfiles.length} new Solana profiles.`);

            // 2. Extract Mints to fetch full pair data
            const mints = solanaProfiles.map((p: any) => p.tokenAddress);

            // 3. Fetch Pair Details (Prices, Liq, Vol)
            return await this.getTokens(mints);

        } catch (error) {
            console.error('[DexScreener] Error fetching latest profiles:', error);
            // Fallback on error
            return await this.search("solana");
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
}
