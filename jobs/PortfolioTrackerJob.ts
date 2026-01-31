import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { logger } from '../utils/Logger';

export class PortfolioTrackerJob {
    private isRunning = false;
    private readonly INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    private readonly MAX_AGE_MS = 72 * 60 * 60 * 1000; // 3 days

    constructor(
        private storage: PostgresStorage,
        private birdeye: BirdeyeService
    ) { }

    start() {
        this.isRunning = true;
        logger.info('[PortfolioTracker] Starting 30-minute monitoring job...');
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

                    // NOTE: BirdEye Public API doesn't have a direct MC Overview endpoint
                    // We'll rely on the MC stored when the token was first found
                    // For now, keep tracking to show on dashboard but don't update MC

                    const currentMc = token.current_mc || token.found_mc || 0;
                    const maxMc = token.max_mc || currentMc;
                    const multiplier = token.found_mc > 0 ? (maxMc / token.found_mc) : 1;

                    logger.info(`[PortfolioTracker] 📊 ${token.symbol} | Found MC: $${Math.floor(token.found_mc || 0)} | Max: $${Math.floor(maxMc)} | ${multiplier.toFixed(2)}x`);
                    updated++;

                    // Rate limit protection
                    await new Promise(r => setTimeout(r, 100));

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
