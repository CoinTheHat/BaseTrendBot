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

                // Security checks (optional, consumes more quota)
                // const securityRes = await axios.get(`${this.baseUrl}/token_security?address=${snap.mint}`, { headers: this.headers });
                // if (securityRes.data?.data) {
                //    snap.devWalletConcentration = ...
                // }

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
}
