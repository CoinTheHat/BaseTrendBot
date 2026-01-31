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
        // Run every 5 minutes: "*/5 * * * *" (more frequent for 15m window)
        this.job = new CronJob('*/5 * * * *', () => {
            this.run();
        });
    }

    start() {
        this.job.start();
        logger.info('[AutopsyJob] Started 15-Minute Monitor (Every 5m).');
    }

    async run() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            await this.storage.backfillMissingTokens();

            // SHORT-TERM TRACKING: Get ALL tokens currently in 'TRACKING' status
            // But we'll timeout tokens older than 15 minutes
            const tokens = await this.storage.getTrackingTokens();

            if (tokens.length === 0) return;

            const FIFTEEN_MINUTES = 15 * 60 * 1000;
            const now = Date.now();

            logger.info(`[Autopsy] 🩺 Vital Check on ${tokens.length} active tokens...`);

            for (const token of tokens) {
                try {
                    // 1. Get Current Price from BirdEye
                    // Note: Birdeye V3 Price endpoint requires normalized address
                    const currentPrice = await this.birdeye.getTokenPrice(String(token.mint), 'solana');
                    if (currentPrice === 0) {
                        // BirdEye might not have data, skip for now
                        continue;
                    }

                    // 2. Calculate Multiplier
                    const entry = token.entryPrice || 0;
                    if (entry === 0) {
                        logger.warn(`[Autopsy] ${token.symbol} has no entry price. Skipping.`);
                        continue;
                    }

                    const multiplier = currentPrice / entry;

                    // 3. Track ATH
                    const currentMc = currentPrice * (token.alertMc / (token.entryPrice || 1)); // Estimate MC
                    const athMc = Math.max(token.athMc, currentMc);

                    // 4. MOON CHECK (2x)
                    if (multiplier >= 2.0) {
                        logger.info(`[Autopsy] 🌝 ${token.symbol} MOONED! ${multiplier.toFixed(2)}x (Entry: $${entry.toFixed(6)}, Current: $${currentPrice.toFixed(6)})`);
                        await this.storage.updatePerformance({
                            ...token,
                            athMc,
                            currentMc,
                            status: 'MOONED'
                        });
                        continue;
                    }

                    // 5. DEATH CHECK (-90%)
                    if (multiplier <= 0.1) {
                        logger.warn(`[Autopsy] 💀 ${token.symbol} FAILED! ${multiplier.toFixed(2)}x (Entry: $${entry.toFixed(6)}, Current: $${currentPrice.toFixed(6)})`);
                        await this.storage.updatePerformance({
                            ...token,
                            athMc,
                            currentMc,
                            status: 'FAILED'
                        });
                        continue;
                    }

                    // 6. TIMEOUT CHECK (15 minutes since alert)
                    const alertTime = token.alertTimestamp.getTime();
                    const timeElapsed = now - alertTime;
                    if (timeElapsed > FIFTEEN_MINUTES) {
                        logger.info(`[Autopsy] ⏱️  ${token.symbol} STALE (15m timeout). ${multiplier.toFixed(2)}x. Finalizing.`);
                        await this.storage.updatePerformance({
                            ...token,
                            athMc,
                            currentMc,
                            status: 'FINALIZED'
                        });
                        continue;
                    }

                    // 7. STILL TRACKING - Update ATH
                    await this.storage.updatePerformance({
                        ...token,
                        athMc,
                        currentMc
                    });

                    logger.debug(`[Autopsy] 📊 ${token.symbol}: ${multiplier.toFixed(2)}x (elapsed: ${Math.floor(timeElapsed / 1000 / 60)}m)`);

                } catch (err) {
                    // Enhanced error logging per user request
                    const errorDetail = (err as any).response?.data ? JSON.stringify((err as any).response.data) : (err as Error).message;
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
