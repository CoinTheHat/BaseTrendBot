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
            // URL: https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20
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

        // 2. Fallback: V3 Token List
        if (items.length === 0) {
            try {
                // V3 List endpoint doesn't support sort_by parameter - returns pre-sorted results
                // URL: https://public-api.birdeye.so/defi/v3/token/list?chain=solana&min_liquidity=5000&limit=50
                const response = await axios.get(`${this.baseUrl}/defi/v3/token/list`, {
                    headers: { ...this.headers, 'x-chain': chain },
                    params: {
                        chain: chain,
                        offset: 0,
                        limit: 50,
                        min_liquidity: 5000
                    }
                });
                items = response.data?.data?.items || [];
                logger.info(`[Birdeye] Fetched ${items.length} Tokens via V3 List Fallback.`);
            } catch (fallbackErr: any) {
                const apiError = fallbackErr.response?.data ? JSON.stringify(fallbackErr.response.data) : fallbackErr.message;
                logger.error(`[Birdeye] V3 Fallback Failed: ${apiError}`);
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
            // https://public-api.birdeye.so/defi/price?address=${address}&chain=solana
            const response = await axios.get(`${this.baseUrl}/defi/price`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: {
                    address,
                    chain // Added per instruction
                }
            });
            return response.data?.data?.value || 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * High-Speed Momentum Check (5 Minute Window)
     * Fetches recent swaps to validate "Ultra-Hot" status.
     */
    async getTokenMomentum(address: string, chain: 'solana' | 'base'): Promise<{ isHot: boolean, swaps: number, volume: number }> {
        if (!config.BIRDEYE_API_KEY) return { isHot: false, swaps: 0, volume: 0 };

        try {
            const now = Math.floor(Date.now() / 1000);
            const fiveMinsAgo = now - 300;

            // URL: https://public-api.birdeye.so/defi/v3/token/txs_by_volume?address=...
            // User Recommendation: Use 'txs_by_volume' to capture BIGGEST trades (Whale Volume)
            const response = await axios.get(`${this.baseUrl}/defi/v3/token/txs_by_volume`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: {
                    address: address,
                    after_time: fiveMinsAgo,
                    before_time: now,
                    type: 'swap', // V3 usually uses 'type' or 'tx_type', keeping standard
                    limit: 100,
                    offset: 0,
                    sort_type: 'desc'
                }
            });

            const items = response.data?.data?.items || [];

            // Analyze Momentum
            let swapCount = 0;
            let totalVolume = 0;

            for (const tx of items) {
                // Determine raw volume (Birdeye usually provides 'value' in USD for swaps, need to check structure)
                // If structure is complex, we try to grab value. 
                // Documentation says 'value' is available in some endpoints. 
                // Creating a safe access.
                const val = tx.value || 0;
                totalVolume += val;
                swapCount++;
            }

            // CRITERIA: Volume is King.
            // User Feedback: "Swap sayısı önemli değil, hacim ve likidite önemli."
            // We keep a minimal swap check (>5) just to ensure it's not a single wash trade.
            const isHot = totalVolume > 5000 && swapCount > 5;

            if (isHot) {
                logger.info(`[Momentum] 🔥 Ultra-Hot: ${address} ($${Math.floor(totalVolume)} Vol, ${swapCount} Swaps)`);
            }

            return { isHot, swaps: swapCount, volume: totalVolume };

        } catch (err: any) {
            // Quiet fail or log debug
            // logger.debug(`[Momentum] Failed for ${address}: ${err.message}`);
            return { isHot: false, swaps: 0, volume: 0 };
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
            // Sanitize address (remove whitespace/newlines)
            address = address.trim();

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
            // Enhanced Error Logging
            const status = error.response?.status;
            const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;

            if (status === 400 && type === '1m') {
                logger.warn(`[Birdeye] 1m Candles not supported/failed for ${address}. Retrying with 15m.`);
                return this.getHistoricalCandles(address, '15m', timeFrom, timeTo);
            }

            if (msg.includes('invalid format')) {
                logger.error(`[Birdeye] 🚨 INVALID ADDRESS FORMAT: "${address}" (Length: ${address.length})`);
            }

            logger.error(`[Birdeye] Fetch OHLCV Failed for ${address} (Status: ${status}): ${msg}`);
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

    /**
     * Get Token Overview (Price, MC, Supply, etc.)
     * Endpoint: /defi/token_overview
     */
    async getTokenOverview(address: string): Promise<{ price: number, mc: number, supply: number, liquidity: number } | null> {
        try {
            const chain = 'solana'; // Default
            const response = await axios.get(`${this.baseUrl}/defi/token_overview`, {
                headers: { ...this.headers, 'x-chain': chain },
                params: { address }
            });

            const data = response.data?.data;
            if (!data) return null;

            return {
                price: data.price || 0,
                mc: data.mc || data.marketCap || 0,
                supply: data.supply || 0,
                liquidity: data.liquidity || 0
            };
        } catch (error) {
            // logger.warn(`[Birdeye] Overview failed for ${address}`);
            return null;
        }
    }

    /**
     * Get Historical Price at specific Unix Timestamp
     * Endpoint: /defi/historical_price_unix
     */
    async getHistoricalPriceUnix(address: string, unixtime: number): Promise<number> {
        try {
            // URL: https://public-api.birdeye.so/defi/historical_price_unix?address=...&unixtime=...
            const response = await axios.get(`${this.baseUrl}/defi/historical_price_unix`, {
                headers: { ...this.headers, 'x-chain': 'solana' },
                params: {
                    address: address,
                    unixtime: unixtime
                }
            });

            if (response.data && response.data.success && response.data.data) {
                return response.data.data.value || 0;
            }
            return 0;

        } catch (error: any) {
            // logger.warn(`[Birdeye] Historical Price failed for ${address}: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get Token Security & Holder Stats (Hybrid Robust Strategy)
     * Primary: /defi/token_holder_distribution (token_address)
     * Fallback: /defi/v3/token/holder (address) + /defi/token_overview (address)
     * Includes 429 Rate Limit Handling and User-Specific Field Requirements
     */
    async getTokenSecurity(address: string): Promise<{ holderCount: number, top10Percent: number }> {
        const makeRequest = async (url: string, params: any, retries = 2): Promise<any> => {
            try {
                return await axios.get(url, {
                    headers: { ...this.headers, 'x-chain': 'solana' },
                    params
                });
            } catch (err: any) {
                if (err.response?.status === 429 && retries > 0) {
                    const wait = (3 - retries) * 2000;
                    logger.warn(`[Birdeye] 429 Rate Limit. Retrying in ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    return makeRequest(url, params, retries - 1);
                }
                throw err;
            }
        };

        try {
            // --- STRATEGY A: Primary Distribution Endpoint ---
            // User Note: MUST use 'token_address' as parameter name
            try {
                const respA = await makeRequest(`${this.baseUrl}/defi/token_holder_distribution`, {
                    token_address: address
                });

                if (respA.data?.success && respA.data?.data) {
                    const data = respA.data.data;
                    const items = data.items || [];
                    // User Note: Use 'percent_of_supply' field
                    const top10 = items.slice(0, 10).reduce((s: number, h: any) => s + (h.percent_of_supply || 0), 0);

                    return {
                        holderCount: data.total || 0,
                        top10Percent: top10 * 100 // Convert to percentage (0.45 -> 45)
                    };
                }
            } catch (errA: any) {
                if (errA.response?.status !== 404) {
                    // Only log non-404 errors as warnings
                    logger.warn(`[Birdeye] Primary Holder API failed for ${address}: ${errA.message}`);
                }
            }

            // --- STRATEGY B: Hybrid Fallback (v3/token/holder + token_overview) ---
            // For new tokens where distribution endpoint fails (404)
            logger.info(`[Birdeye] Using Fallback Holder Logic for ${address}...`);

            // 1. Get Top Holders List
            const respB1 = await makeRequest(`${this.baseUrl}/defi/v3/token/holder`, {
                address: address,
                offset: 0,
                limit: 10
            });

            // 2. Get Supply via Overview
            const respB2 = await makeRequest(`${this.baseUrl}/defi/token_overview`, {
                address: address
            });

            if (respB1.data?.data && respB2.data?.data) {
                const holders = respB1.data.data.items || [];
                const supply = respB2.data.data.supply || 0;
                const totalHolders = respB1.data.data.total || 0;

                // User Note: Calculate Top 10 percentage manually using supply
                if (supply > 0) {
                    // Use ui_amount (float) for calculation to matches supply units
                    const top10Raw = holders.slice(0, 10).reduce((s: number, h: any) => s + (Number(h.ui_amount) || 0), 0);
                    const top10Percent = top10Raw / supply;

                    return {
                        holderCount: totalHolders,
                        top10Percent: top10Percent * 100
                    };
                }
            }

            throw new Error(`Holder data retrieved but supply/metrics missing for ${address}`);

        } catch (err: any) {
            // FAIL-SAFE: Rejections handled in TokenScanJob
            logger.warn(`[Birdeye] Global Holder Failure for ${address}: ${err.message}`);
            throw err;
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
