import axios from 'axios';
import { TokenSnapshot, TokenPerformance } from '../models/types';
import { config } from '../config/env';
import { logger } from '../utils/Logger';

export class BirdeyeService {
    private baseUrl = 'https://public-api.birdeye.so';
    private headers = {
        'X-API-KEY': config.BIRDEYE_API_KEY,
        'accept': 'application/json'
    };

    /**
     * Fetch newly listed tokens (Discovery)
     * Endpoint: /defi/v2/tokens/new_listing
     */
    async fetchNewListings(chain: 'solana' | 'base', limit: number = 20): Promise<TokenSnapshot[]> {
        if (!config.BIRDEYE_API_KEY) {
            logger.warn('[Birdeye] Missing API Key');
            return [];
        }

        try {
            const response = await axios.get(`${this.baseUrl}/defi/v2/tokens/new_listing`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: {
                    limit,
                    meme_platform_enabled: true, // Focus on meme tokens
                    min_liquidity: 5000 // Server-side pre-filtering
                }
            });

            const items = response.data?.data?.items || [];
            if (!Array.isArray(items)) return [];

            return items.map((item: any) => this.mapListingToSnapshot(item, chain));

        } catch (error: any) {
            logger.error(`[Birdeye] Fetch New Listings (${chain}) Failed: ${error.message}`);
            return [];
        }
    }



    /**
     * Get Historical Candles (OHLCV)
     * Endpoint: /defi/ohlcv
     */
    async getHistoricalCandles(address: string, type: '1m' | '15m', timeFrom: number, timeTo: number): Promise<{ h: number, l: number, o: number, c: number, v: number, u: number }[]> {
        // Defaults: 'solana' only for now, unless address starts with 0x
        const chain = address.startsWith('0x') ? 'base' : 'solana';

        try {
            const response = await axios.get(`${this.baseUrl}/defi/ohlcv`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: {
                    address,
                    type,
                    time_from: timeFrom,
                    time_to: timeTo
                }
            });

            return response.data?.data?.items || [];
        } catch (error: any) {
            logger.error(`[Birdeye] Fetch OHLCV Failed for ${address}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get Token ATH via OHLCV (Legacy - can use getHistoricalCandles internally if needed)
     */
    async getTokenATH(address: string, chain: 'solana' | 'base'): Promise<number> {
        try {
            const now = Math.floor(Date.now() / 1000);
            const start = now - (24 * 60 * 60); // 24h ago

            const response = await axios.get(`${this.baseUrl}/defi/ohlcv`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: {
                    address,
                    type: '15m',
                    time_from: start,
                    time_to: now
                }
            });

            const items = response.data?.data?.items || [];
            if (!items.length) return 0;

            // Find max High
            let maxHigh = 0;
            for (const item of items) {
                if (item.h > maxHigh) maxHigh = item.h;
            }
            return maxHigh;

        } catch (error) {
            return 0;
        }
    }

    // --- Helpers ---

    private mapListingToSnapshot(item: any, chain: 'solana' | 'base'): TokenSnapshot {
        return {
            source: 'birdeye',
            chain: chain, // Explicit chain
            mint: item.address,
            name: item.name || 'Unknown',
            symbol: item.symbol || 'UNK',

            // Hydration from BirdEye
            priceUsd: item.price || 0,
            liquidityUsd: item.liquidity || 0,
            marketCapUsd: item.mc || item.marketCap || 0, // IMPORTANT: Capture MC here
            volume24hUsd: item.v24hUSD || 0,

            createdAt: new Date(item.liquidityAddedAt || Date.now()),
            updatedAt: new Date(),

            links: {
                birdeye: `https://birdeye.so/token/${item.address}?chain=${chain}`,
                dexScreener: `https://dexscreener.com/${chain}/${item.address}`
            }
        };
    }
}
