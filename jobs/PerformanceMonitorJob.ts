import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { DexScreenerService } from '../services/DexScreenerService';
import { ScandexBot } from '../telegram/TelegramBot';
import { TokenPerformance } from '../models/types';
import { AutopsyService } from '../services/AutopsyService';

export class PerformanceMonitorJob {
    private job: CronJob;
    private isRunning: boolean = false;
    private autopsyService: AutopsyService;

    constructor(
        private storage: PostgresStorage,
        private dexScreener: DexScreenerService,
        private bot: ScandexBot,
        autopsyService: AutopsyService // Injected
    ) {
        this.autopsyService = autopsyService;
        // Run every minute for fast reaction to dips and monitoring
        this.job = new CronJob('*/1 * * * *', () => {
            this.run();
        });
    }

    start() {
        this.job.start();
        logger.info('[AutopsyJob] Started Monitor (1m interval).');
    }

    async run() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            // 1. Check for Dips
            await this.checkDipCandidates();

            await this.storage.backfillMissingTokens();

            // 2. Monitor Active Tracking Tokens (DISABLED - Saving CPU, using BirdEye API later)
            // await this.monitorTrackingTokens();

            // 3. Run Autopsy (True ATH for AI Training) (DISABLED)
            // await this.runAutopsy();

        } catch (error) {
            logger.error('[AutopsyJob] Failed:', error);
        } finally {
            this.isRunning = false;
        }
    }

    private async runAutopsy() {
        // Fetch tokens finalized > 24h ago needing autopsy
        const candidates = await this.storage.getAutopsyCandidates();

        if (candidates.length === 0) return;

        logger.info(`[AutopsyJob] 🔬 Performing autopsy on ${candidates.length} tokens...`);

        for (const token of candidates) {
            const entryTime = new Date(token.alertTimestamp).getTime();
            // GAP FILLING ALGORITHM
            const trueAth = await this.autopsyService.calculateTrueAth(token.mint, entryTime);

            // Infer Market Cap from Price if supply known, otherwise just update Price
            // Note: PostgresStorage expects MC, but calculateTrueAth returns Price.
            // We need to convert Price back to MC using supply snapshot.
            // Estimate Supply = AlertMC / EntryPrice
            const supply = (token.alertMc && token.entryPrice) ? (token.alertMc / token.entryPrice) : 0;
            const trueAthMc = supply > 0 ? trueAth * supply : 0;

            if (trueAthMc > 0) {
                await this.storage.updateTrueAth(token.mint, trueAthMc);
            } else {
                // If we can't calc MC, valid update to mark processed
                await this.storage.updateTrueAth(token.mint, token.athMc);
            }
        }
    }

    private async checkDipCandidates() {
        const candidates = await this.storage.getWaitingForDipTokens();
        if (candidates.length === 0) return;

        logger.info(`[DipMonitor] 👀 Watching ${candidates.length} tokens for entry...`);

        // Bulk Fetch
        const mints = candidates.map(c => c.mint);
        const liveData = await this.dexScreener.getTokens(mints);
        const priceMap = new Map<string, number>();

        // Map Mint -> Price (Use highest liquidity pair if dupes?)
        // DexScreener 'getTokens' might return multiple pairs.
        // We'll trust getTokens returns good snapshots, maybe multiple.
        for (const snap of liveData) {
            // Use the first one or override if we find better? 
            // Simple: Just use the first one found for the mint.
            if (!priceMap.has(snap.mint)) {
                priceMap.set(snap.mint, snap.priceUsd || 0);
            }
        }

        for (const token of candidates) {
            try {
                // Check timeout (10m)
                const age = Date.now() - new Date(token.alertTimestamp).getTime();
                if (age > 10 * 60 * 1000) {
                    await this.storage.failDipToken(token.mint, 'MISSED_DIP');
                    logger.info(`[DipMonitor] ⌛ ${token.symbol} missed dip window. Cancelled.`);
                    continue;
                }

                const price = priceMap.get(token.mint);
                if (!price || price === 0) continue;

                // Infer Supply to get Current MC
                const supply = (token.alertMc && token.entryPrice) ? (token.alertMc / token.entryPrice) : 0;
                const currentMc = supply > 0 ? price * supply : 0;

                if (currentMc > 0 && currentMc <= token.dipTargetMc) {
                    // HIT!
                    await this.storage.activateDipToken(token.mint, price, currentMc);
                    await this.bot.sendDipAlert({
                        symbol: token.symbol,
                        mint: token.mint,
                        currentMc,
                        dipTargetMc: token.dipTargetMc
                    });
                    logger.info(`[DipMonitor] 🎯 ${token.symbol} DIP ENTRY TRIGGERED @ $${Math.floor(currentMc)}`);
                }
            } catch (e) {
                logger.error(`[DipMonitor] Error checking ${token.symbol}: ${e}`);
            }
        }
    }

    private async monitorTrackingTokens() {
        // SHORT-TERM TRACKING: Get ALL tokens currently in 'TRACKING' status
        const tokens = await this.storage.getTrackingTokens();

        if (tokens.length === 0) return;

        // logger.debug(`[Autopsy] 🩺 Vital Check on ${tokens.length} active tokens...`); // Silenced by user request

        // Bulk Fetch
        const mints = tokens.map(t => t.mint);
        const liveData = await this.dexScreener.getTokens(mints);
        const priceMap = new Map<string, number>();
        for (const snap of liveData) {
            if (!priceMap.has(snap.mint)) priceMap.set(snap.mint, snap.priceUsd || 0);
        }

        for (const token of tokens) {
            try {
                const currentPrice = priceMap.get(token.mint);

                if (!currentPrice) {
                    // Skip if no data
                    continue;
                }

                // 2. Calculate Multiplier
                const entry = token.entryPrice || 0;
                if (entry === 0) {
                    // logger.warn(`[Autopsy] ${token.symbol} has no entry price. Skipping.`);
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

                // 6. TIMEOUT CHECK REMOVED
                // Tokens now stay in TRACKING until 48h (handled by Portfolio or Cleanup)

                // 7. STILL TRACKING - Update ATH
                await this.storage.updatePerformance({
                    ...token,
                    athMc,
                    currentMc
                });

            } catch (err) {
                logger.error(`[Autopsy] Error for ${token.symbol}: ${err}`);
            }
        }
    }
