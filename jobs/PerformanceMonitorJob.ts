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

            // CONTINUOUS TRACKING: Get ALL tokens currently in 'TRACKING' status
            // We do NOT filter by 15 mins. We check them forever (until Moon or Die).
            const tokens = await this.storage.getTrackingTokens();

            if (tokens.length === 0) return;

            const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
            const now = Date.now();

            logger.info(`[Autopsy] 🩺 Vital Check on ${tokens.length} active tokens...`);

            for (const token of tokens) {
                try {
                    // 0. Timeout Check (24 Hours)
                    // If a token does nothing for 24 hours, we drop it to save resources.
                    const age = now - new Date(token.alertTimestamp).getTime();
                    if (age > TWENTY_FOUR_HOURS) {
                        logger.info(`[Autopsy] 💤 Token ${token.symbol} is stale (>24h). Finalizing as STALE.`);
                        await this.finalizeToken(token, 'FINALIZED', token.currentMc, token.currentMc); // Or a new status like 'STALE'
                        continue;
                    }

                    // 1. Get Current Price
                    // Note: Birdeye V3 Price endpoint is cheap (CUs).
                    const currentPrice = await this.birdeye.getTokenPrice(token.mint, 'solana');

                    if (!currentPrice || currentPrice === 0) {
                        // logger.warn(`[Autopsy] No price for ${token.symbol}. Skipping.`);
                        continue;
                    }

                    // 2. Determine Entry Price
                    const entryPrice = token.entryPrice || (token.alertMc > 0 ? (token.alertMc / 1000000000) : 0);

                    if (entryPrice === 0) {
                        // Impossible to calc multiplier without entry. 
                        // If we have alertMc, we can try to compare MC if we fetch "Token Overview".
                        // But for now, we skip or assume failed if very old.
                        continue;
                    }

                    // 3. Calculate Multiplier
                    const multiplier = currentPrice / entryPrice;
                    const approxCurrentMc = multiplier * (token.alertMc || 0);

                    // 4. Decision Logic (User: 2x Moon / -90% Death)
                    let outcome = 'TRACKING';

                    if (multiplier >= 2.0) {
                        outcome = 'MOONED';
                    } else if (multiplier <= 0.1) {
                        outcome = 'FAILED';
                    }

                    // Log only significant updates to avoid spam
                    // logger.info(`[Autopsy] ${token.symbol}: ${multiplier.toFixed(2)}x ($${currentPrice}). Status: ${outcome}`);

                    if (outcome !== 'TRACKING') {
                        logger.info(`🏁 [Autopsy] ${token.symbol} Finalized: ${outcome} (${multiplier.toFixed(2)}x)`);
                        await this.finalizeToken(token, outcome, approxCurrentMc, approxCurrentMc);
                    } else {
                        // Just update Last Seen / Current MC for dashboard
                        token.currentMc = approxCurrentMc;
                        token.lastUpdated = new Date();
                        // Special method to just update current stats without finalizing? 
                        // existing updatePerformance updates status too. 
                        await this.storage.updatePerformance(token);
                    }

                } catch (err: any) {
                    // Enhanced Error Logging for diagnosis
                    const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
                    logger.error(`[Autopsy] Error for ${token.symbol}: ${errorDetail}`);
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
