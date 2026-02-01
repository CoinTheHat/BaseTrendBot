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

            for (const token of tokens) {
                try {
                    const foundAt = new Date(token.found_at).getTime();
                    const now = Date.now();
                    const age = now - foundAt;

                    // ARCHIVE old tokens (>3 days)
                    if (age > this.MAX_AGE_MS) {
                        await this.storage.archiveToken(token.mint);
                        archived++;
                        logger.info(`[PortfolioTracker] 📦 Archived ${token.symbol} (${token.mint}) - 72h limit reached.`);
                    }
                } catch (err) {
                    logger.error(`[PortfolioTracker] Error processing ${token.symbol}: ${err}`);
                }
            }

            if (archived > 0) {
                logger.info(`[PortfolioTracker] ✅ Cycle complete | Archived ${archived} tokens.`);
            }

        } catch (err) {
            logger.error(`[PortfolioTracker] Cycle failed: ${err}`);
        }
    }
}
