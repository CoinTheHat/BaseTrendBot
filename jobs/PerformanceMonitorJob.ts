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
            await this.storage.backfillMissingTokens();
            const tokens = await this.storage.getTrackingTokens();
            if (tokens.length === 0) return;

            const now = Date.now();
            const FIFTEEN_MINS = 15 * 60 * 1000;

            const targets = tokens.filter(t => {
                const age = now - new Date(t.alertTimestamp).getTime();
                return age >= FIFTEEN_MINS;
            });

            if (targets.length === 0) return;

            logger.info(`[Autopsy] 💀 Performing 15-min post-mortem on ${targets.length} tokens...`);

            for (const token of targets) {
                try {
                    const alertTime = new Date(token.alertTimestamp).getTime() / 1000;
                    const endTime = alertTime + 900; // +15 Minutes

                    // Fetch 1m Candles
                    const candles = await this.birdeye.getHistoricalCandles(token.mint, '1m', alertTime, endTime);

                    if (!candles || candles.length === 0) {
                        logger.warn(`[Autopsy] No candle data for ${token.symbol}. Finalizing as FAILED.`);
                        await this.finalizeToken(token, 'FAILED', 0, 0);
                        continue;
                    }

                    // Find ATH & Entry
                    let autopsyHigh = 0;

                    for (const c of candles) {
                        // Birdeye returns 'u' for unix timestamp
                        if (c.u >= alertTime) {
                            if (c.h > autopsyHigh) autopsyHigh = c.h;
                        }
                    }

                    // Fallback
                    if (autopsyHigh === 0) {
                        const maxC = Math.max(...candles.map(c => c.h));
                        autopsyHigh = maxC > 0 ? maxC : token.alertMc;
                    }

                    const entryPrice = candles[0]?.o || 1;
                    const multiplier = autopsyHigh / entryPrice;
                    const athMc = multiplier * (token.alertMc || 1);
                    const currentMc = candles[candles.length - 1].c * (token.alertMc / entryPrice);

                    const outcome = (athMc >= (token.alertMc || 1) * 2) ? 'MOONED' : 'FAILED';

                    logger.info(`🏁 [Autopsy] ${token.symbol}: ${multiplier.toFixed(2)}x (ATH $${Math.floor(athMc)}). Result: ${outcome}`);

                    await this.finalizeToken(token, outcome, athMc, currentMc);

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

    private async finalizeToken(token: any, outcome: string, athMc: number, currentMc: number) {
        let finalStatus = 'FINALIZED';
        if (outcome === 'MOONED') finalStatus = 'FINALIZED_MOONED';
        else if (outcome === 'FAILED') finalStatus = 'FINALIZED_FAILED';

        token.status = finalStatus;
        token.athMc = athMc;
        token.currentMc = currentMc;
        token.lastUpdated = new Date();

        await this.storage.updatePerformance(token);
        logger.info(`[Autopsy] 🏁 ${token.symbol} Finalized: ${finalStatus}`);
    }
}
