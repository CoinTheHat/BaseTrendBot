import { BirdeyeService } from './BirdeyeService';
import { logger } from '../utils/Logger';

export class AutopsyService {
    constructor(private birdeye: BirdeyeService) { }

    /**
     * Calculates the "True ATH" (All-Time High) seen within 24 hours of entry.
     * Uses a "Gap Filling" algorithm to ensure precision:
     * 1. Phase 1 (Gap): 1m candles from Entry -> Next 15m Boundary (Captures immediate wicks)
     * 2. Phase 2 (Main): 15m candles from Boundary -> 24h Mark (Efficient trend tracking)
     * 
     * @param mint Token Contract Address
     * @param entryTimestamp Unix Timestamp (ms) of when the bot entered/alerted
     * @returns The highest price (USD) seen in the 24h window
     */
    async calculateTrueAth(mint: string, entryTimestamp: number): Promise<number> {
        // ... (existing code)
        const entryUnix = Math.floor(entryTimestamp / 1000);
        const end24h = entryUnix + (24 * 60 * 60);

        // Calculate next 15-minute boundary (900 seconds)
        // e.g., if 14:03, next boundary is 14:15
        const nextBoundary = Math.ceil(entryUnix / 900) * 900;

        let maxPrice = 0;
        let gapCandlesCount = 0;
        let mainCandlesCount = 0;

        try {
            // PHASE 1: GAP FILLING (1m Precision)
            // Only run if there is actually a gap (entry is not perfectly aligned)
            if (nextBoundary > entryUnix) {
                const gapCandles = await this.birdeye.getHistoricalCandles(
                    mint,
                    '1m',
                    entryUnix,
                    nextBoundary
                );
                gapCandlesCount = gapCandles.length;
                for (const c of gapCandles) {
                    if (c.h > maxPrice) maxPrice = c.h;
                }
            }

            // PHASE 2: MAIN TREND (15m Efficiency)
            // Fetch from boundary to 24h end
            if (end24h > nextBoundary) {
                const mainCandles = await this.birdeye.getHistoricalCandles(
                    mint,
                    '15m',
                    nextBoundary,
                    end24h
                );
                mainCandlesCount = mainCandles.length;
                for (const c of mainCandles) {
                    if (c.h > maxPrice) maxPrice = c.h;
                }
            }

            logger.info(`[Autopsy] 🩺 Analyzed ${mint}: Gap(${gapCandlesCount}x1m) + Main(${mainCandlesCount}x15m) -> True ATH: $${maxPrice}`);
            return maxPrice;

        } catch (err) {
            logger.error(`[Autopsy] Failed to calculate True ATH for ${mint}: ${err}`);
            return 0;
        }
    }

    /**
     * Get specific price at a target timestamp (e.g. 30 mins after entry)
     * Precision: 1 minute
     */
    async getPriceAtTime(mint: string, targetTimestamp: number): Promise<number> {
        const targetUnix = Math.floor(targetTimestamp / 1000);
        // Look for candle between T and T+60s
        try {
            const candles = await this.birdeye.getHistoricalCandles(
                mint,
                '1m',
                targetUnix,
                targetUnix + 120 // 2 min window just in case
            );

            if (candles.length > 0) {
                // Return Close price of first candle
                return candles[0].c;
            }
            return 0;
        } catch (err) {
            logger.warn(`[Autopsy] Failed to get PriceAtTime for ${mint}: ${err}`);
            return 0;
        }
    }
}
