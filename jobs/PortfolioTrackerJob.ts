import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { logger } from '../utils/Logger';

export class PortfolioTrackerJob {
    private isRunning = false;
    private readonly INTERVAL_MS = 60 * 60 * 1000; // 1 Hour (API Safety)
    private readonly MAX_AGE_MS = 72 * 60 * 60 * 1000; // 3 days

    constructor(
        private storage: PostgresStorage,
        private birdeye: BirdeyeService
    ) { }

    start() {
        this.isRunning = true;
        logger.info('[PortfolioTracker] Starting 1-hour monitoring job...');
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
            logger.info('[PortfolioTracker] 🔄 Starting tracking cycle (Archival Only)...');

            const tokens = await this.storage.getAllTrackingTokens();

            if (tokens.length === 0) {
                logger.info('[PortfolioTracker] No tokens in watchlist.');
                return;
            }

            let archived = 0;
            let updated = 0;

            for (const token of tokens) {
                try {
                    const foundAt = new Date(token.found_at).getTime();
                    const now = Date.now();
                    const age = now - foundAt;

                    // 1. ARCHIVE old tokens (>72 hours)
                    if (age > this.MAX_AGE_MS) {
                        await this.storage.archiveToken(token.mint);
                        archived++;
                        logger.info(`[PortfolioTracker] 📦 Archived ${token.symbol} (${token.mint}) - 72h limit reached.`);
                        continue;
                    }

                    // 2. UPDATE MAX MC (ATH Tracking)
                    // Only check if it's active (TRACKING)
                    const overview = await this.birdeye.getTokenOverview(token.mint);
                    if (overview) {
                        const currentMc = overview.mc;
                        // Calculate Peak Price since Alert
                        const alertTimeSec = Math.floor(foundAt / 1000);
                        const nowSec = Math.floor(now / 1000);

                        const peakPrice = await this.birdeye.getTokenPeakPrice(token.mint, alertTimeSec, nowSec);
                        const maxMc = peakPrice * overview.supply;

                        // Persist to DB
                        await this.storage.savePerformance({
                            mint: token.mint,
                            symbol: token.symbol,
                            alertMc: token.alert_mc, // Keep original
                            athMc: maxMc > token.ath_mc ? maxMc : token.ath_mc, // Update if higher
                            currentMc: currentMc,
                            entryPrice: token.entry_price,
                            status: token.status, // Keep status
                            alertTimestamp: token.found_at, // Keep original
                            lastUpdated: new Date()
                        });
                        updated++;
                    }

                    // Rate Limit Protection (1s delay between tokens)
                    await new Promise(r => setTimeout(r, 1000));

                } catch (err) {
                    logger.error(`[PortfolioTracker] Error processing ${token.symbol}: ${err}`);
                }
            }

            if (updated > 0 || archived > 0) {
                logger.info(`[PortfolioTracker] ✅ Cycle complete | Updated: ${updated} | Archived: ${archived}`);
            }

        } catch (err) {
            logger.error(`[PortfolioTracker] Cycle failed: ${err}`);
        }
    }
}
