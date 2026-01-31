import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { config } from '../config/env';

export class PerformanceMonitorJob {
    private job: CronJob;
    private isRunning: boolean = false;

    constructor(
        private storage: PostgresStorage,
        private birdeye: BirdeyeService
    ) {
        // Run every 10 minutes: "*/10 * * * *"
        this.job = new CronJob('*/10 * * * *', () => {
            this.run();
        });
    }

    start() {
        this.job.start();
        logger.info('[AutopsyJob] Started One-Shot Monitor (Every 10m).');
    }

    async run() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            // STEP 0: BACKFILL (Ensure seen_tokens -> token_performance)
            await this.storage.backfillMissingTokens();

            // STEP 1: Get Targets (Older than 60 mins, TRACKING only)
            const tokens = await this.storage.getTrackingTokens();
            if (tokens.length === 0) return;

            const now = Date.now();
            const ONE_HOUR = 60 * 60 * 1000;

            // Filter for targets ready for Autopsy (Age > 60 mins)
            const targets = tokens.filter(t => {
                const age = now - new Date(t.alertTimestamp).getTime();
                return age >= ONE_HOUR;
            });

            if (targets.length === 0) {
                // logger.info('[Autopsy] No tokens ready for autopsy yet.');
                return;
            }

            logger.info(`[Autopsy] 💀 Performing post-mortem on ${targets.length} tokens...`);

            // STEP 2: The Autopsy
            for (const token of targets) {
                try {
                    const alertTime = new Date(token.alertTimestamp).getTime() / 1000;
                    const endTime = alertTime + 3600; // +1 Hour

                    // Fetch 15m Candles for that specific hour
                    const candles = await this.birdeye.getHistoricalCandles(token.mint, '15m', alertTime, endTime);

                    if (!candles || candles.length === 0) {
                        logger.warn(`[Autopsy] No candle data for ${token.symbol}. Marking FAILED (No Data).`);
                        token.status = 'FAILED_NO_DATA';
                        await this.storage.updatePerformance(token);
                    } else {
                        // Find True Wick High
                        let maxPrice = 0;
                        for (const c of candles) {
                            if (c.h > maxPrice) maxPrice = c.h;
                        }

                        // Calculate ATH Market Cap
                        // ATH_MC = (MaxPrice / EntryPrice) * AlertMc.
                        // EntryPrice: Use first candle open
                        const entryPrice = candles[0]?.o || 1;
                        const multiplier = maxPrice / entryPrice;
                        const athMc = multiplier * (token.alertMc || 1);

                        token.athMc = athMc;
                        token.currentMc = candles[candles.length - 1].c * (token.alertMc / entryPrice); // Approx current

                        // VERDICT
                        const entryMc = token.alertMc || 1;
                        let outcome: 'MOONED' | 'FAILED' = 'FAILED';

                        if (athMc >= entryMc * 2) {
                            outcome = 'MOONED';
                        }

                        logger.info(`🏁 [Autopsy] ${token.symbol}: Entry $${Math.floor(entryMc)} -> ATH $${Math.floor(athMc)} (${multiplier.toFixed(2)}x). Result: ${outcome}`);

                        // FINALIZATION
                        let finalStatus: 'FINALIZED' | 'FINALIZED_MOONED' | 'FINALIZED_FAILED' = 'FINALIZED';

                        if (outcome === 'MOONED') finalStatus = 'FINALIZED_MOONED';
                        else if (outcome === 'FAILED') finalStatus = 'FINALIZED_FAILED';

                        token.status = finalStatus;
                        await this.storage.updatePerformance(token);
                    }

                } catch (err) {
                    logger.error(`[Autopsy] Error for ${token.symbol}: ${err}`);
                }
            }

        } catch (error) {
            logger.error('[AutopsyJob] Failed:', error);
        } finally {
            this.isRunning = false;
        }
    }
}
