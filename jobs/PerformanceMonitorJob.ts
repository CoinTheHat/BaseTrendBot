import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { DexScreenerService } from '../services/DexScreenerService';
import { config } from '../config/env';

export class PerformanceMonitorJob {
    private job: CronJob;
    private isRunning: boolean = false;

    constructor(
        private storage: PostgresStorage,
        private dexScreener: DexScreenerService
    ) {
        // Run every 1 minutes: "0 */1 * * * *" to capture ATH better
        this.job = new CronJob('0 */1 * * * *', () => {
            this.run();
        });
    }

    start() {
        this.job.start();
        logger.info('[PerformanceJob] Started (Every 10m).');
    }

    async run() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            // STEP 0: BACKFILL - Sync missing tokens from processed_tokens
            await this.storage.backfillMissingTokens();

            // STEP 1: Get tokens to check
            // Only checking 'TRACKING' tokens alerted in last 48h
            const tokens = await this.storage.getTrackingTokens();

            if (tokens.length === 0) {
                // logger.debug('[PerformanceJob] No active tokens to track.');
                return;
            }

            logger.info(`[PerformanceJob] Checking ${tokens.length} tokens...`);

            // 2. Fetch current prices via DexScreener
            // We need to chunk them if too many (DexScreener limit ~30)
            const mints = tokens.map(t => t.mint);

            // Re-use logic from DexScreenerService if avail, or call checkTokens
            // Service method getTokens handles chunking internally.
            const snapshots = await this.dexScreener.getTokens(mints);

            // 3. Compare & Update
            for (const snap of snapshots) {
                const perf = tokens.find(t => t.mint === snap.mint);
                if (!perf) continue;

                const currentMc = snap.marketCapUsd || 0;
                if (currentMc === 0) continue;

                // SELF-HEALING: Fix missing data from Backfilled items
                let isRepairNeeded = false;
                if (!perf.symbol || perf.alertMc === 0) {
                    isRepairNeeded = true;
                    // Fix Symbol
                    if (snap.symbol) {
                        perf.symbol = snap.symbol;
                    }
                    // Fix Alert MC (If 0, assume current is entry)
                    if (perf.alertMc === 0) {
                        perf.alertMc = currentMc;
                        // If ATH is also 0, fix it too
                        if (perf.athMc === 0) {
                            perf.athMc = currentMc;
                        }
                    }
                }

                let newAth = perf.athMc;
                if (currentMc > perf.athMc) {
                    newAth = currentMc;
                }

                // Check Status Logic
                let newStatus = perf.status;

                // Moon Check: > 2x Alert Price
                // Note: We are using MC. Multiplier = Current / Alert.
                const multiplier = currentMc / (perf.alertMc || 1); // Avoid div0

                if (multiplier >= 2) {
                    newStatus = 'MOONED';
                } else if (multiplier <= 0.2) {
                    // Rug Check: < 0.2x (80% drop)
                    // Only mark rug if it's been > 30 mins since alert (give it room to breathe/volatility)
                    const timeDiff = Date.now() - new Date(perf.alertTimestamp).getTime();
                    if (timeDiff > 30 * 60 * 1000) {
                        newStatus = 'RUGGED';
                    }
                }

                // Update DB only if changed significantly (ATH or Status)
                // Or update `current_mc` always to keep dashboard fresh? 
                // Updating always is better for the "Recent Calls" table.

                perf.athMc = newAth;
                perf.currentMc = currentMc;
                perf.status = newStatus;
                perf.lastUpdated = new Date(); // handled by DB trigger/query usually, but we send it

                if (isRepairNeeded) {
                    logger.info(`[PerformanceJob] repairing data for ${perf.symbol || perf.mint}`);
                    await this.storage.updatePerformanceEnriched(perf);
                } else {
                    await this.storage.updatePerformance(perf);
                }
            }

            logger.info(`[PerformanceJob] Updated ${snapshots.length} tokens.`);

        } catch (error) {
            logger.error('[PerformanceJob] Failed:', error);
        } finally {
            this.isRunning = false;
        }
    }
}
