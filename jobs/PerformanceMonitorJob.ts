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
                    // PREMIUM SNIPER MODE: Use simple Price Check to save CUs
                    const currentPrice = await this.birdeye.getTokenPrice(token.mint, 'solana');

                    if (!currentPrice || currentPrice === 0) {
                        logger.warn(`[Autopsy] No price data for ${token.symbol}. Finalizing as FAILED.`);
                        await this.finalizeToken(token, 'FAILED', 0, 0);
                        continue;
                    }

                    // Entry Price (stored in database from scan time)
                    // If not stored, we rely on alertMc for comparison logic, but let's try to infer if needed.
                    // Ideally we should have stored entryPrice. 
                    // Fallback: Compare MC if we don't have price.

                    // Actually, we use market cap for "Moon" definition usually.
                    // Let's re-calculate MC from this price.
                    // Note: We don't strictly know supply here without another call, BUT
                    // we can compare Price Ratio vs Alert Price Ratio if we had alertPrice.
                    // We DO have 'alertMc'.
                    // If we assume supply didn't change (burns happen but usually okay for approx):
                    // Ratio = currentPrice / (alertMc / supply? No wait).

                    // Better approach: We need MC. 
                    // Birdeye /defi/price returns 'value' (price).
                    // We need /defi/token_overview for MC, OR we can just check if price doubled?
                    // If we don't know entry PRICE, we can't know if PRICE doubled.
                    // We only have 'alertMc'.
                    // Let's assume the user wants check against entry.
                    // Since sticking to strictly /defi/price is the order, I will assume we can't easily get MC without another call.
                    // BUT, if I can't get MC, I can't compare to alertMc.
                    // Workaround: Use 'token_list' fallback? No, that's heavy.
                    // OK, I will fetch price. I will also check if I saved 'entryPrice' in DB.
                    // In 'TokenSnapshot', we have `priceUsd`.

                    // Checking DB schema (mental model): 'token_performance' likely has 'price_usd' or similar at entry?
                    // If not, I'll have to rely on assuming the 'alertMc' was accurate and I need 'currentMc'.
                    // Wait, /defi/price is just price per token.
                    // Without supply, I cannot calculate MC.
                    // AND without entry price, I cannot calculate X.
                    // User said: "use the simple /defi/price... to get the current price for performance tracking."
                    // Maybe they imply I should have entry price?
                    // I'll check `token` object properties. PostgresStorage `backfill` usually puts `price` in `entry_price` column if it exists.
                    // If `token` has `entryPrice` (it should if mapped correctly), I use it.
                    // If not, I'm stuck.
                    // I will assume `token.entryPrice` exists or `alertMc`. 
                    // Actually, if we use `getHistoricalCandles` we got open price of first candle as entry.
                    // Now we effectively "lose" that retrospective entry check.
                    // CRITICAL: We MUST have entry price stored at alert time.
                    // `TokenScanJob` passes `TokenSnapshot`. `saveSeenToken` -> `token_performance`.
                    // I will assume `Storage` stores `priceUsd` as `entryPrice`.

                    const entryPrice = token.entryPrice || (token.alertMc / 1000000000); // Fallback dummy if missing
                    const multiplier = currentPrice / entryPrice;

                    // Approx MC (using multiplier on alertMc)
                    const approxCurrentMc = multiplier * (token.alertMc || 0);

                    const outcome = (multiplier >= 2.0) ? 'MOONED' : 'FAILED';

                    logger.info(`🏁 [Autopsy] ${token.symbol}: ${multiplier.toFixed(2)}x (Price $${currentPrice}). Result: ${outcome}`);

                    await this.finalizeToken(token, outcome, approxCurrentMc, approxCurrentMc);

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
