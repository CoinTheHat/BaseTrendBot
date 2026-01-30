import axios from 'axios';
import { TokenSnapshot } from '../models/types';
import { config } from '../config/env';

export class BirdeyeService {
    private baseUrl = 'https://public-api.birdeye.so/defi';
    private headers = {
        'X-API-KEY': config.BIRDEYE_API_KEY,
        'x-chain': 'solana',
        'accept': 'application/json'
    };

    /**
     * Enrich a list of tokens with Birdeye data (Overview, Security)
     * This is expensive on quota, so use selectively.
     */
    async enrichTokens(snapshots: TokenSnapshot[]): Promise<TokenSnapshot[]> {
        if (!config.BIRDEYE_API_KEY) return snapshots; // Skip if no key

        const enriched: TokenSnapshot[] = [];

        for (const snap of snapshots) {
            try {
                // Fetch Token Overview
                // GET /defi/token_overview?address=...
                const overviewRes = await axios.get(`${this.baseUrl}/token_overview?address=${snap.mint}`, { headers: this.headers });
                const data = overviewRes.data?.data;

                if (data) {
                    snap.marketCapUsd = data.mc || data.realMc || snap.marketCapUsd;
                    snap.priceUsd = data.price || snap.priceUsd;
                    snap.liquidityUsd = data.liquidity || snap.liquidityUsd;
                    snap.volume30mUsd = data.v30mUSD || snap.volume30mUsd; // Ensure API has this field
                    snap.links.birdeye = `https://birdeye.so/token/${snap.mint}?chain=solana`;

                    // Birdeye often has holder data here too
                    // snap.buyers... not directly in overview usually, needs different endpoint
                }

                // Security checks (optional, consumes more quota - enabled for Detective Mode)
                try {
                    const securityRes = await axios.get(`${this.baseUrl}/token_security?address=${snap.mint}`, { headers: this.headers });
                    const secData = securityRes.data?.data;
                    if (secData) {
                        // Map Birdeye security fields
                        snap.mintAuthority = secData.mutableMetadata || secData.mintable; // logic depends on API, usually 'mintable' checks authority
                        if (secData.top10HolderPercent) {
                            snap.top10HoldersSupply = secData.top10HolderPercent * 100; // API usually returns 0.5 for 50%
                        }
                    }
                } catch (err) {
                    // Security check failed (likely 404 or quota), ignore to keep flow
                }

                snap.source = (snap.source === 'pumpfun' || snap.source === 'dexscreener') ? 'combined' : snap.source;
                enriched.push(snap);

            } catch (error: any) {
                // If 401/403 (quota), log warning once
                if (error.response?.status === 401) {
                    console.warn('[Birdeye] API Key invalid or missing permissions');
                }
                enriched.push(snap); // Return original if fail
            }
        }

        return enriched;
    }
    /**
     * Fetch newly listed tokens on Solana via Birdeye.
     * Useful when Pump.fun or DexScreener search is limited.
     */
    async getNewTokens(limit: number = 10): Promise<TokenSnapshot[]> {
        if (!config.BIRDEYE_API_KEY) return [];

        try {
            const res = await axios.get(`${this.baseUrl}/new_listing?limit=${limit}`, { headers: this.headers });
            const items = res.data?.data?.items;

            if (!items || !Array.isArray(items)) return [];

            return items.map((item: any) => ({
                source: 'birdeye',
                mint: item.address,
                name: item.name || 'Unknown',
                symbol: item.symbol || 'UNK',
                priceUsd: item.price,
                liquidityUsd: item.liquidity,
                volume30mUsd: item.v24hUSD ? item.v24hUSD / 48 : 0, // Approx if only 24h available, but Birdeye usually gives 24h
                updatedAt: new Date(),
                createdAt: new Date(item.liquidityAddedAt || Date.now()), // API specific
                links: {
                    birdeye: `https://birdeye.so/token/${item.address}?chain=solana`,
                    dexScreener: `https://dexscreener.com/solana/${item.address}`
                }
            }));
        } catch (err: any) {
            console.warn(`[Birdeye] Failed to fetch new tokens: ${err.message}`);
            return [];
        }
    }

    async getTokenMetadata(address: string): Promise<{ symbol: string; name: string } | null> {
        if (!config.BIRDEYE_API_KEY) return null;

        try {
            // Using the endpoint requested: /defi/v3/token/meta-data/single
            const res = await axios.get(`${this.baseUrl}/v3/token/meta-data/single`, {
                params: { address },
                headers: this.headers
            });

            if (res.data && res.data.success && res.data.data) {
                const { symbol, name } = res.data.data;
                return { symbol, name };
            }
            return null;
        } catch (error: any) {
            // console.log(`[BirdEye] API Error: ${error.message}`);
            return null;
        }
    }
}
