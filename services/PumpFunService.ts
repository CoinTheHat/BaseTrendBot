import axios from 'axios';
import { TokenSnapshot } from '../models/types';
import { config } from '../config/env';

export class PumpFunService {
    private baseUrl = 'https://frontend-api.pump.fun';

    /**
     * Fetches the latest created tokens from Pump.fun using their public API.
     */
    async getNewTokens(): Promise<TokenSnapshot[]> {
        try {
            // Using the 'latest' or 'creation' endpoint. 
            // Note: This endpoint is public but might be rate limited.
            const response = await axios.get(`${this.baseUrl}/coins/latest?offset=0&limit=10&includeNsfw=false`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://pump.fun',
                    'Referer': 'https://pump.fun/'
                },
                timeout: 5000
            });

            if (!response.data || !Array.isArray(response.data)) {
                return [];
            }

            const tokens = response.data.map((t: any) => this.normalizeToken(t));
            console.log(`[PumpFun] Fetched ${tokens.length} new tokens.`);
            return tokens;

        } catch (error: any) {
            // Cloudflare 530 is common on Railway/Hosting IPs.
            if (error.response?.status === 530 || error.response?.status === 403) {
                console.warn('[PumpFun] Direct API access blocked by Cloudflare (Expected on VPS). Relying on DexScreener for PumpFun tokens.');
                return [];
            }
            console.error('[PumpFun] Error fetching new tokens:', error instanceof Error ? error.message : error);
            return [];
        }
    }

    /**
     * Convert raw PumpFun API data to our normalized Snapshot
     */
    private normalizeToken(raw: any): TokenSnapshot {
        return {
            source: 'pumpfun',
            mint: raw.mint,
            name: raw.name,
            symbol: raw.symbol,
            priceUsd: raw.usd_market_cap ? raw.usd_market_cap / 1000000000 : 0, // Very rough approx if not provided
            marketCapUsd: raw.usd_market_cap || 0,
            liquidityUsd: 0, // Pumpfun doesn't expose strict liq in this endpoint usually
            volume5mUsd: 0,
            volume30mUsd: 0,
            createdAt: new Date(raw.created_timestamp),
            updatedAt: new Date(),
            links: {
                pumpfun: `https://pump.fun/${raw.mint}`
            }
        };
    }
}
