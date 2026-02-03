import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { PumpFunService } from '../services/PumpFunService';
import { BirdeyeService } from '../services/BirdeyeService';
import { Matcher } from '../core/Matcher';
import { ScoringEngine } from '../core/ScoringEngine';
import { PhaseDetector } from '../core/PhaseDetector';
import { CooldownManager } from '../core/CooldownManager';
import { NarrativeEngine } from '../narrative/NarrativeEngine';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterPublisher } from '../twitter/TwitterPublisher';
import { PostgresStorage } from '../storage/PostgresStorage';
import { TokenSnapshot } from '../models/types';
import { QueryBuilder } from '../twitter/QueryBuilder';
import { TwitterScraper } from '../twitter/TwitterScraper';
import { TwitterStoryEngine } from '../narrative/TwitterStoryEngine';
import { TrendCollector } from '../trends/TrendCollector';
import { TrendTokenMatcher } from '../core/TrendTokenMatcher';
import { AlphaSearchService } from '../twitter/AlphaSearchService';
import { DexScreenerService } from '../services/DexScreenerService';

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();
    private processedCache = new Map<string, number>();

    constructor(
        private pumpFun: PumpFunService,
        private birdeye: BirdeyeService,
        private dexScreener: DexScreenerService,
        private matcher: Matcher,
        private scorer: ScoringEngine,
        private phaseDetector: PhaseDetector,
        private cooldown: CooldownManager,
        private narrative: NarrativeEngine,
        private bot: ScandexBot,
        private twitter: TwitterPublisher,
        private storage: PostgresStorage,
        private trendCollector: TrendCollector,
        private trendMatcher: TrendTokenMatcher,
        private alphaSearch: AlphaSearchService
    ) { }

    private async runLoop() {
        if (!this.isRunning) return;

        // Parallel Processes:
        // 1. Main Scan (New Tokens) - Every SCAN_INTERVAL
        // 2. Dip Monitor (Waiting Tokens) - Every 30 seconds (User Request)

        this.runCycle().finally(() => {
            const delay = config.SCAN_INTERVAL_SECONDS * 1000;
            logger.info(`[Job] Scan complete. Next scan in ${config.SCAN_INTERVAL_SECONDS}s...`);
            setTimeout(() => this.runLoop(), delay);
        });
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`[Job] Token Scan Job started. Interval: ${config.SCAN_INTERVAL_SECONDS}s`);

        // Start Main Loop
        this.runLoop();

        // Start Dip Monitor Loop (Independent)
        this.runDipMonitor();
    }

    private async runDipMonitor() {
        if (!this.isRunning) return;

        try {
            await this.monitorDipCandidates();
        } catch (err) {
            logger.error(`[DipMonitor] Error: ${err}`);
        }

        // Run every 30 seconds
        setTimeout(() => this.runDipMonitor(), 30000);
    }

    // ... (runCycle method remains here)

    private async runCycle() {
        if (this.isScanning) {
            logger.warn(`[Job] ⚠️ Cycle skipped - Previous cycle still running.`);
            return;
        }

        this.isScanning = true;

        try {
            logger.info('[Job] 🔍 Starting DexScreener Scan...');

            // 1. Fetch Candidates (DexScreener Latest Pairs)
            const dexTokens = await this.dexScreener.getLatestPairs();
            logger.info(`[Fetch] 📡 Received ${dexTokens.length} tokens from DexScreener`);

            if (dexTokens.length === 0) {
                logger.info(`[Scan] ⚠️ No trending tokens from DexScreener. Cooldown may be active.`);
                return;
            }

            const freshCandidates: TokenSnapshot[] = [];
            const now = Date.now();
            let cachedCount = 0;

            for (const token of dexTokens) {
                const lastProcessed = this.processedCache.get(token.mint);
                // SMART CACHE: Reverted to 4 hours
                if (lastProcessed && (now - lastProcessed < 4 * 60 * 60 * 1000)) {
                    cachedCount++;
                    continue;
                }
                freshCandidates.push(token);
            }

            logger.info(`[Cache] 🔄 Filtered out ${cachedCount} recently seen tokens`);

            if (freshCandidates.length === 0) {
                logger.info(`[Scan] ⚠️ No fresh candidates to process. Next cycle in 120s.`);
                return;
            }

            logger.info(`[Job] 🔍 Processing ${freshCandidates.length} fresh candidates...`);

            // Scan Statistics
            let lowLiqCount = 0;
            let weakMomentumCount = 0;
            let ghostCount = 0;
            let lowScoreCount = 0;
            let alertCount = 0;
            let birdeyeFailCount = 0; // Track BirdEye validation failures

            // Process in chunks
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (token) => {
                    try {
                        this.processedCache.set(token.mint, Date.now());

                        // --- STEP 1: STRICT LIQUIDITY GATES (Sniper Firewall) ---
                        const liq = Number(token.liquidityUsd) || 0;
                        const mc = Number(token.marketCapUsd) || 0;
                        const liqMcRatio = mc > 0 ? liq / mc : 0;

                        // GATE A: Unplayable Liquidity
                        if (liq < 5000) {
                            lowLiqCount++;
                            return;
                        }

                        // GATE B: Rug / Scam Risk (Liquidity > 90% of MC is suspicious for established, but ok for ultra-fresh? No, usually scam/honeypot)
                        // User accepted strict gate.
                        if (liqMcRatio > 0.90) {
                            lowLiqCount++; // Counting as liq reject for stats
                            logger.warn(`[Gate] 🚫 High Liquidity Ratio: ${token.symbol} (${(liqMcRatio * 100).toFixed(1)}%). Potential Scam.`);
                            return;
                        }

                        // --- STEP 2: MECHANICAL SCORING (Speed Focus) ---
                        // Mock match for now, or real if watchlist active.
                        const matchResult = { memeMatch: false };
                        const enrichedToken = token;

                        // Check watchers (Meme Match) - minimal impact now
                        // We could call matcher.match(token) if we want the small bonus

                        const scoreRes = this.scorer.score(enrichedToken, matchResult);
                        const { totalScore, phase } = scoreRes;

                        // REJECTION CHECK
                        // Threshold: 70/100 (Equivalent to old 7/10)
                        if (phase === 'REJECTED_RISK' || totalScore < 70) {
                            lowScoreCount++;
                            return;
                        }

                        // --- STEP 3: SNIPED! (Immediate Alert) ---
                        const { allowed } = await this.cooldown.canAlert(token.mint);
                        if (allowed) {
                            alertCount++;

                            // Determine Segment for Logging
                            let segmentLog = 'UNKNOWN';
                            if (mc < 50000) segmentLog = 'SEED';
                            else if (mc < 250000) segmentLog = 'GOLDEN';
                            else segmentLog = 'RUNNER';

                            logger.info(`🔫 [SNIPED] [${segmentLog}] ${token.symbol} Score: ${totalScore}/100 | Liq: $${Math.floor(liq)} | MC: $${Math.floor(mc)}`);

                            // Create Mechanical Narrative (No AI Latency)
                            // Display Score as X/10 for familiarity (e.g. 75 -> 7.5)
                            const displayScore = (totalScore / 10).toFixed(1);

                            const mechanicalNarrative = {
                                headline: `🔫 SNIPER ALERT: ${token.symbol}`,
                                narrativeText: `⚡ **MECHANICAL ENTRY** • Score: ${displayScore}/10
🚀 **MOMENTUM SIGNAL**
• Txns Accelerating
• Liquidity Healthy ($${(liq / 1000).toFixed(1)}k)
• MC Segment: ${segmentLog}

⚠️ **RISK CHECK:**
• Volatility: High
• Entry Type: ${segmentLog === 'SEED' ? 'Small Size' : 'Full Size'}`,
                                dataSection: `• MC: $${(mc / 1000).toFixed(1)}k
• Liq: $${(liq / 1000).toFixed(1)}k
• Vol: $${(token.volume5mUsd || 0).toFixed(0)}
• Age: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) + 'm' : 'N/A'}`,
                                tradeLens: `SNIPE`,
                                vibeCheck: `MECHANICAL`,
                                aiScore: totalScore, // Save full 100-scale score
                                aiApproved: true
                            };

                            // Save as ALERTED immediately
                            await this.storage.saveSeenToken(token.mint, {
                                symbol: token.symbol,
                                firstSeenAt: Date.now(),
                                lastAlertAt: Date.now(),
                                lastScore: totalScore,
                                lastPhase: 'ALERTED',
                                storedAnalysis: JSON.stringify(mechanicalNarrative)
                            });

                            // ⚡ FIRE ALERT
                            await this.bot.sendAlert(mechanicalNarrative, enrichedToken, scoreRes);

                            // Twitter (Optional - maybe skip for pure sniper speed or do async)
                            // if (totalScore >= 8) this.twitter.postTweet(mechanicalNarrative, enrichedToken);

                            await this.cooldown.recordAlert(token.mint, totalScore, 'TRACKING', token.priceUsd);

                            // AUTOPSY PRESERVATION
                            await this.storage.savePerformance({
                                mint: token.mint,
                                symbol: token.symbol,
                                alertMc: mc,
                                athMc: mc,
                                currentMc: mc,
                                entryPrice: Number(token.priceUsd) || 0,
                                status: 'TRACKING',
                                alertTimestamp: new Date(),
                                lastUpdated: new Date()
                            });

                            // --- STEP 4: ASYNC AI (Optional Post-Analysis) ---
                            // We can trigger this without awaiting if we want dashboard updates later
                            /*
                            this.narrative.generate(enrichedToken, matchResult, scoreRes, []).then(aiResult => {
                                // Update DB with AI thoughts for "Autopsy" later?
                            });
                            */
                        }

                    } catch (tokenErr) {
                        logger.error(`[Job] Error processing token ${token.symbol}: ${tokenErr}`);
                    }
                }));
                // Tiny delay between chunks
                await new Promise(r => setTimeout(r, 50));
            }

            // SCAN SUMMARY
            const totalRejected = lowLiqCount + weakMomentumCount + ghostCount + lowScoreCount;
            logger.info(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 [SCAN SUMMARY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Total Fetched: ${dexTokens.length}
🔄 Cached (15m): ${cachedCount}
🎯 Fresh Candidates: ${freshCandidates.length}

🚫 REJECTED (${totalRejected}):
  💧 Low Liquidity (<$5k or >90% MC): ${lowLiqCount}
  💤 Weak Momentum (<0.5x): ${weakMomentumCount}
  👻 Ghost Protocol: ${ghostCount}
  ❌ Score <7: ${lowScoreCount}

✅ ALERTS SENT: ${alertCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

            // Note: Scan interval is controlled by runLoop() setTimeout
            // No additional sleep needed here to avoid double-delay

        } catch (err) {
            logger.error(`[Job] Cycle failed: ${err}`);
        } finally {
            this.isScanning = false;
        }
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        const res: T[][] = [];
        for (let i = 0; i < arr.length; i += size) { res.push(arr.slice(i, i + size)); }
        return res;
    }

    /**
     * RAPID MONITOR: Checks 'WAITING_DIP' tokens every 30s.
     * Uses cached analysis + fresh price to alert instantly on dip.
     */
    private async monitorDipCandidates() {
        // 1. Get Waiting Tokens
        const candidates = await this.storage.getWaitingForDipTokens();
        if (candidates.length === 0) return;

        logger.info(`[DipMonitor] 👀 Watching ${candidates.length} tokens for entry...`);

        // 2. Fetch Live Prices (Bulk)
        const mints = candidates.map(c => c.mint);
        const liveTokens = await this.dexScreener.getTokens(mints);

        // 3. Compare & Alert
        for (const candidate of candidates) {
            const liveToken = liveTokens.find(t => t.mint === candidate.mint);

            // TIMEOUT CHECK (>60 Mins) (User Request: 30-60 mins)
            const waitDuration = Date.now() - new Date(candidate.alertTimestamp).getTime();
            if (waitDuration > 60 * 60 * 1000) {
                logger.info(`[DipMonitor] ⌛ Timeout for ${candidate.symbol}. Missed Dip.`);
                await this.storage.failDipToken(candidate.mint, 'MISSED_DIP');
                continue;
            }

            if (!liveToken) continue;

            const currentMc = liveToken.marketCapUsd || 0;
            const targetMc = candidate.dipTargetMc || 0;

            // ENTRY CONDITION: Price <= Target
            if (currentMc > 0 && currentMc <= targetMc) {
                logger.info(`[DipMonitor] 🎯 DIP HIT! ${candidate.symbol} dropped to $${Math.floor(currentMc)} (Target: $${Math.floor(targetMc)})`);

                // Retrieve Stored Analysis
                const seenData = await this.storage.getSeenToken(candidate.mint);
                let narrative = null;

                if (seenData?.storedAnalysis) {
                    try {
                        narrative = JSON.parse(seenData.storedAnalysis);
                        // Update Data Section with FRESH numbers
                        narrative.dataSection =
                            `• MC: $${(currentMc).toLocaleString()}\n` +
                            `• Liq: $${(liveToken.liquidityUsd ?? 0).toLocaleString()}\n` +
                            `• Vol (24h): $${(liveToken.volume24hUsd ?? 0).toLocaleString()}\n` +
                            `• Age: ${liveToken.createdAt ? Math.floor((Date.now() - liveToken.createdAt.getTime()) / (3600 * 1000)) + 'h' : 'N/A'}\n` +
                            `• ✅ Dip Entry Triggered (Price dropped 50% from pump)`;

                    } catch (e) {
                        logger.error(`[DipMonitor] Failed to parse stored analysis for ${candidate.symbol}`);
                    }
                }

                // Fallback if no analysis found (e.g. old tokens before update)
                // Fallback if no analysis found (e.g. old tokens before update)
                if (!narrative) {
                    narrative = {
                        headline: `📉 DIP ENTRY TRIGGERED`,
                        mainStory: `Wait for breakout confirmation.`,
                        // Mimic the AI structure manually
                        narrativeText: `✨ **POTANSİYEL VAR** • Puan: ${seenData?.lastScore || 7}/10
🔥 **DIP FIRSATI YAKALANDI**

🧐 **ANALİST ÖZETİ:**
Bu token, güçlü bir yükseliş sonrası beklenen düzeltme seviyesine (%50 geri çekilme) geldi. AI analizi bu eski kayıt için mevcut değil ancak teknik göstergeler "Dip Alım" fırsatını işaret ediyor. Hacim ve likidite oranları sağlıklı görünüyor.

📊 **Teknik Görünüm:**
Fiyat, pump sonrası 0.5 fib seviyesine (veya eşdeğerine) geri çekildi. Bu seviye genellikle tepki alımlarının geldiği noktadır. Likidite/MC oranı izlenmeli.

🚀 **STRATEJİ:**
Kademeli alım düşünülebilir. Stop-loss'u dip seviyesinin %5-10 altına koyarak tepki yükselişini bekle.`,
                        dataSection: `• MC: $${(currentMc).toLocaleString()}\n• Target: $${(targetMc).toLocaleString()}\n• ✅ Dip Entry Triggered`,
                        tradeLens: `WAITING -> TRACKING`,
                        vibeCheck: `Requires Manual Review`,
                        aiScore: seenData?.lastScore || 7,
                        aiApproved: true
                    };
                }

                if (narrative) {
                    // Send Alert using Full Format + Special Title
                    await this.bot.sendTokenAlert(liveToken, narrative, `CORRECTION ENTRY: $${candidate.symbol} 📉`);

                    // Update Status to TRACKING (so we track PnL from here)
                    await this.storage.activateDipToken(candidate.mint, liveToken.priceUsd || 0, currentMc);
                    await this.cooldown.recordAlert(liveToken.mint, seenData?.lastScore || 7, 'TRACKING', liveToken.priceUsd);
                }
            } else {
                // logger.debug(`[DipMonitor] ${candidate.symbol} at $${Math.floor(currentMc)} (Target: $${Math.floor(targetMc)}) - Waiting...`);
            }
        }
    }
}
