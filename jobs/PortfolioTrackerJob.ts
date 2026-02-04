import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { AutopsyService } from '../services/AutopsyService';
import { logger } from '../utils/Logger';

export class PortfolioTrackerJob {
    private isRunning = false;
    private readonly INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 Hours
    private readonly MATURITY_AGE_MS = 24 * 60 * 60 * 1000; // 24 Hours

    constructor(
        private storage: PostgresStorage,
        private birdeye: BirdeyeService,
        private autopsyService: AutopsyService
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
                    // If token is younger than 24 hours, do NOTHING.
                    // The user wants ZERO unnecessary API calls.
                    // The "Gap Filling" autopsy at 24h will look back and find high prices anyway.
                    if (age < this.MATURITY_AGE_MS) {
                        skipped++;
                        continue;
                    }

                    // 2. MATURITY REACHED (>24h) -> EXECUTE AUTOPSY
                    // logger.info(`[Portfolio] 🏁 Finalizing ${token.symbol} (Age: ${(age/3600000).toFixed(1)}h)...`);

                    // A. Gap Filling (Capture Hidden Wicks)
                    const trueAthPrice = await this.autopsyService.calculateTrueAth(token.mint, foundAt);

                    // B. Current Stats (Snapshot for closing)
                    const overview = await this.birdeye.getTokenOverview(token.mint);
                    const currentMc = overview?.mc || 0;

                    // C. Calculate Final Metrics
                    const entryMc = token.alertMc || 1;
                    const supply = (token.alertMc && token.entryPrice) ? (token.alertMc / token.entryPrice) : 0;
                    const trueAthMc = supply > 0 ? trueAthPrice * supply : 0;

                    // Logic: Uses the maximum of tracked ATH or True ATH
                    // (Postgres 'athMc' might be 0 if we never tracked it)
                    const finalAthMc = Math.max(token.athMc, trueAthMc);

                    // D. Determine Verdict
                    const multiple = trueAthMc / entryMc; // Judge by ATH
                    let status = 'FINALIZED';

                    if (multiple >= 2.0) status = 'MOONED';
                    else if (multiple <= 0.5) status = 'FAILED'; // Strict failure 
                    // Note: User might want 'RUGGED' but 'FAILED' is safe default if rug isn't confirmed.
                    // If currentMc is near zero, maybe RUGGED.
                    if (currentMc < (entryMc * 0.1)) status = 'RUGGED';

                    // E. Save & Archive
                    await this.storage.updatePerformance({
                        ...token,
                        currentMc,
                        athMc: finalAthMc,
                        status: status // This updates status to MOONED/FAILED/RUGGED
                    });

                    // Move to Archive to stop tracking
                    await this.storage.archiveToken(token.mint);

                    finalized++;
                    logger.info(`[Portfolio] ✅ Finalized ${token.symbol}: ${status} (ATH: $${(finalAthMc / 1000).toFixed(1)}k, ${multiple.toFixed(1)}x)`);

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
