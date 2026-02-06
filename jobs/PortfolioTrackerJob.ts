import { PostgresStorage } from '../storage/PostgresStorage';
import { DexScreenerService } from '../services/DexScreenerService';
import { logger } from '../utils/Logger';
import { TokenPerformance } from '../models/types';

export class PortfolioTrackerJob {
    private isRunning = false;
    private readonly INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 Hours
    private readonly MATURITY_AGE_MS = 24 * 60 * 60 * 1000; // 24 Hours

    constructor(
        private storage: PostgresStorage,
        private dexScreener: DexScreenerService
    ) { }

    start() {
        this.isRunning = true;
        logger.info('[PortfolioTracker] Starting 4-hour monitoring job (Finalizer Only)...');
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
            logger.info('[PortfolioTracker] 🔄 Starting Portfolio Finalization Cycle...');

            // Get ALL active tokens
            const tokens = await this.storage.getTrackingTokens();

            if (tokens.length === 0) {
                logger.info('[PortfolioTracker] No tokens in watchlist.');
                return;
            }

            let finalized = 0;
            let skipped = 0;

            for (const token of tokens) {
                try {
                    const foundAt = new Date(token.alertTimestamp).getTime();
                    const now = Date.now();
                    const age = now - foundAt;

                    // 1. SILENCE CHECK
                    if (age < this.MATURITY_AGE_MS) {
                        skipped++;
                        continue;
                    }

                    // 2. MATURITY REACHED (>24h) -> FINALIZE

                    // A. Gap Filling REMOVED (Relies on Live Tracking now)
                    // The "True ATH" is whatever biggest number we saw while tracking.
                    const trueAthMc = token.athMc;

                    // B. Current Stats (Snapshot for closing)
                    // Use DexScreener
                    const pairs = await this.dexScreener.getTokens([token.mint]);
                    const pair = pairs && pairs.length > 0 ? pairs[0] : null;
                    const currentMc = pair && pair.marketCapUsd ? pair.marketCapUsd : 0;

                    // C. Calculate Final Metrics
                    const entryMc = token.alertMc || 1;

                    // D. Determine Verdict
                    const multiple = trueAthMc / entryMc; // Judge by ATH
                    let status: TokenPerformance['status'] = 'FINALIZED';

                    if (multiple >= 2.0) status = 'MOONED';
                    else if (multiple <= 0.5) status = 'FAILED';

                    if (currentMc < (entryMc * 0.1)) status = 'RUGGED';

                    // E. Save & Archive
                    await this.storage.updatePerformance({
                        ...token,
                        currentMc,
                        athMc: trueAthMc,
                        status: status
                    });

                    // Move to Archive to stop tracking
                    await this.storage.archiveToken(token.mint);

                    finalized++;
                    logger.info(`[Portfolio] ✅ Finalized ${token.symbol}: ${status} (ATH: $${(trueAthMc / 1000).toFixed(1)}k, ${multiple.toFixed(1)}x)`);

                    // Rate Limit Kindness
                    await new Promise(r => setTimeout(r, 200));

                } catch (err) {
                    logger.error(`[PortfolioTracker] Error finalizing ${token.symbol}: ${err}`);
                }
            }

            logger.info(`[PortfolioTracker] Cycle Complete. Finalized: ${finalized} | Pending (Maturity < 24h): ${skipped}`);

        } catch (err) {
            logger.error(`[PortfolioTracker] Cycle failed: ${err}`);
        }
    }
}
