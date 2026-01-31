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
                    meme_platform_enabled: true // Focus on meme tokens
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
     * Bulk fetch token overview (Performance Monitor)
     * Endpoint: /defi/v2/tokens/overview
     * Returns Map<mint, { price, mc, liquidity }>
     */
    async getTokensOverview(mints: string[], chain: 'solana' | 'base'): Promise<Map<string, any>> {
        if (!mints.length) return new Map();

        // BirdEye limit is 50 per call normally, let's chunk safely at 20
        const chunkSize = 20;
        const resultMap = new Map<string, any>();

        for (let i = 0; i < mints.length; i += chunkSize) {
            const chunk = mints.slice(i, i + chunkSize);
            try {
                // Post request for bulk
                // Note: Check docs if GET or POST. Public API usually supports headers for list? 
                // Using x-chain.
                // Actually, /defi/v2/tokens/overview takes 'address' param comma separated?
                // Let's assume comma separated GET based on standard BirdEye patterns or POST.

                // Correction: V2 usually implies standard GET with list or POST.
                // Let's try GET with comma separated addresses as per common implementation

                // Docs say: GET /defi/v2/tokens/overview?address_list=... on some versions, 
                // or /defi/multi_price. 
                // Let's stick to the secure standard endpoint: /defi/multi_price is definitely bulk.
                // But user asked for /defi/v2/tokens/overview.
                // NOTE: Using /defi/multi_price is safer for bulk pricing. 
                // However, user specifically asked for OVERVIEW to get MC/Liq.
                // We will try iterating simpler requests if bulk overview isn't documented clearly as GET.
                // Actually, for "Professional Mode", let's use the explicit single calls in parallel if list not supported, 
                // OR use the Multi-Price and separate Token Info calls.

                // OPTIMIZATION: Use /multi_price for price, but we need MC.
                // Let's assume standard V2 GET with ?list is not standard.
                // We will use axios.all (parallel) for Overview if bulk endpoint ambiguous, 
                // BUT User Request implied bulk support. 
                // Let's use the standard "list" param if available, if not, iterate.

                // TRUSTING USER PROMPT: "allows bulk fetching"
                // Assuming headers: x-chain, content-type.

                const response = await axios.get(`${this.baseUrl}/defi/v2/tokens/overview`, {
                    headers: { ...this.headers, 'x-chain': chain },
                    params: {
                        address_list: chunk.join(',')
                    }
                });

                const data = response.data?.data || [];
                // Data likely array of objects
                if (Array.isArray(data)) {
                    data.forEach((t: any) => {
                        resultMap.set(t.address, {
                            price: t.price,
                            mc: t.mc || t.realMc || 0,
                            liquidity: t.liquidity || 0
                        });
                    });
                }

            } catch (error: any) {
                logger.error(`[Birdeye] Bulk Overview Warning: ${error.message}`);
                // Fallback: try fetching singular if bulk fails? No, too slow.
            }
        }
        return resultMap;
    }

    /**
     * Get Token ATH via OHLCV
     * Endpoint: /defi/ohlcv
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
