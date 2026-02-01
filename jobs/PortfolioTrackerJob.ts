import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { logger } from '../utils/Logger';

export class PortfolioTrackerJob {
    private isRunning = false;
    private readonly INTERVAL_MS = 30 * 1000; // 30 seconds (User request)
    private readonly MAX_AGE_MS = 72 * 60 * 60 * 1000; // 3 days

    constructor(
        private storage: PostgresStorage,
        private birdeye: BirdeyeService
    ) { }

    start() {
        this.isRunning = true;
        logger.info('[PortfolioTracker] Starting 30-second monitoring job...');
        this.runLoop();
    }

    stop() {
        this.isRunning = false;
        logger.info('[PortfolioTracker] Stopped.');
    }

    private async runLoop() {
        if (!this.isRunning) return;

        await this.runCycle();

        setTimeout(() => this.runLoop(), this.INTERVAL_MS);
    }

    private async runCycle() {
        try {
            logger.info('[PortfolioTracker] 🔄 Starting tracking cycle...');

            const tokens = await this.storage.getAllTrackingTokens();

            if (tokens.length === 0) {
                logger.info('[PortfolioTracker] No tokens to track.');
                return;
            }

            logger.info(`[PortfolioTracker] Tracking ${tokens.length} tokens...`);

            let archived = 0;
            let updated = 0;
            let failed = 0;

            for (const token of tokens) {
                try {
                    const foundAt = new Date(token.found_at).getTime();
                    const now = Date.now();
                    const age = now - foundAt;

                    // ARCHIVE old tokens (>3 days)
                    if (age > this.MAX_AGE_MS) {
                        await this.storage.archiveToken(token.mint);
                        archived++;
                        logger.debug(`[PortfolioTracker] Archived ${token.symbol} (${token.mint}) - Too old`);
                        continue;
                    }

                    // 1. Calculate Supply & Heal Missing Data
                    let entryPrice = Number(token.entry_price || 0);
                    let foundMc = Number(token.found_mc || 0);
                    let supply = 0;

                    if (entryPrice <= 0 || foundMc <= 0) {
                        // SELF-HEALING: Fetch fresh data if DB is missing entry points
                        const overview = await this.birdeye.getTokenOverview(token.mint);
                        if (overview) {
                            entryPrice = overview.price;
                            foundMc = overview.mc; // Re-baseline to now
                            supply = overview.supply;

                            logger.info(`[PortfolioTracker] 🩹 Healed missing data for ${token.symbol} (MC: $${Math.floor(foundMc)})`);
                        } else {
                            logger.debug(`[PortfolioTracker] ⚠️ Skipping update for ${token.symbol}: Missing entry data`);
                            continue;
                        }
                    } else {
                        supply = foundMc / entryPrice;
                    }

                    // 2. Fetch Market Data (1m Candles for last 60 mins to catch spikes)
                    const timeTo = Math.floor(now / 1000);
                    const timeFrom = timeTo - (60 * 60); // 60 mins ago

                    const candles = await this.birdeye.getHistoricalCandles(token.mint, '1m', timeFrom, timeTo);

                    let currentPrice = entryPrice;
                    let batchHighPrice = entryPrice;

                    if (candles.length > 0) {
                        // Find Highs and Close
                        const lastCandle = candles[candles.length - 1];
                        currentPrice = lastCandle.c;

                        // Find max high in this batch
                        for (const c of candles) {
                            if (c.h > batchHighPrice) batchHighPrice = c.h;
                        }
                    } else {
                        // Fallback to simple price check if no candles
                        currentPrice = await this.birdeye.getTokenPrice(token.mint, 'solana'); // Defaulting solana for simplicity
                        if (currentPrice > batchHighPrice) batchHighPrice = currentPrice;
                    }

                    // 3. Calculate MCs
                    const currentMc = currentPrice * supply;
                    const batchMaxMc = batchHighPrice * supply;

                    // 4. Update DB (Safe Update: Max MC only increases)
                    // We pass `batchMaxMc` as the potential new high. DB `GREATEST()` handles the rest.
                    await this.storage.updateTokenMC(token.mint, currentMc, batchMaxMc);
                    updated++;

                    // 5. Log Performance
                    const dbMax = Number(token.max_mc || 0);
                    const realMax = Math.max(dbMax, batchMaxMc); // Visual only
                    const multiplier = (realMax / foundMc);

                    logger.info(`[PortfolioTracker] 📊 ${token.symbol} | Now: $${Math.floor(currentMc)} | ATH: $${Math.floor(realMax)} (${multiplier.toFixed(2)}x)`);

                    // Rate limit protection
                    await new Promise(r => setTimeout(r, 200));

                } catch (err) {
                    logger.error(`[PortfolioTracker] Error tracking ${token.symbol}: ${err}`);
                    failed++;
                }
            }

            logger.info(`[PortfolioTracker] ✅ Cycle complete | Updated: ${updated} | Archived: ${archived} | Failed: ${failed}`);

        } catch (err) {
            logger.error(`[PortfolioTracker] Cycle failed: ${err}`);
        }
    }
}
