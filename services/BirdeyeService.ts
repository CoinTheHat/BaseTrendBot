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
     * Fetch Trending Tokens (Premium Sniper Mode)
     * Primary: /defi/token_trending (Rank-based high movers)
     * Fallback: /defi/v3/token/list (High Volume)
     */
    async fetchTrendingTokens(chain: 'solana' | 'base'): Promise<TokenSnapshot[]> {
        if (!config.BIRDEYE_API_KEY) return [];

        let items: any[] = [];

        // 1. Try TRENDING Endpoint
        try {
            const response = await axios.get(`${this.baseUrl}/defi/token_trending`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: {
                    sort_by: 'rank',
                    sort_type: 'asc',
                    offset: 0,
                    limit: 20
                }
            });
            items = response.data?.data?.items || [];
            if (items.length > 0) {
                logger.info(`[Birdeye] Fetched ${items.length} Trending Tokens (V3 Rank).`);
            }
        } catch (err: any) {
            logger.warn(`[Birdeye] Trending API failed (${err.message}). Switching to V3 List fallback.`);
        }

        // 2. Fallback: V3 Token List (Volume Sorted)
        if (items.length === 0) {
            try {
                const response = await axios.get(`${this.baseUrl}/defi/v3/token/list`, {
                    headers: { ...this.headers, 'x-chain': chain },
                    params: {
                        sort_by: 'v24hUSD',
                        sort_type: 'desc',
                        offset: 0,
                        limit: 50,
                        min_liquidity: 5000
                    }
                });
                items = response.data?.data?.items || [];
                logger.info(`[Birdeye] Fetched ${items.length} Tokens via V3 List Fallback.`);
            } catch (fallbackErr: any) {
                logger.error(`[Birdeye] V3 Fallback Failed: ${fallbackErr.message}`);
                return [];
            }
        }

        return items.map((item: any) => this.mapListingToSnapshot(item, chain));
    }

    /**
     * Get Current Price (Simple check for Autopsy)
     * Endpoint: /defi/price
     */
    async getTokenPrice(address: string, chain: 'solana' | 'base'): Promise<number> {
        try {
            const response = await axios.get(`${this.baseUrl}/defi/price`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: { address }
            });
            return response.data?.data?.value || 0;
        } catch (error) {
            return 0;
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
