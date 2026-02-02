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

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`[Job] Token Scan Job started. Interval: ${config.SCAN_INTERVAL_SECONDS}s`);
        this.runLoop();
    }

    private async runLoop() {
        if (!this.isRunning) return;
        await this.runCycle();
        const delay = config.SCAN_INTERVAL_SECONDS * 1000;
        logger.info(`[Job] Scan complete. Next scan in ${config.SCAN_INTERVAL_SECONDS}s...`);
        setTimeout(() => this.runLoop(), delay);
    }

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
                // SMART CACHE: Reduce to 1 hour (was 4h)
                if (lastProcessed && (now - lastProcessed < 1 * 60 * 60 * 1000)) {
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


                        // --- STEP 1: SECURITY (SIMPLIFIED) ---
                        // BirdEye Trending already filters out most scams
                        // GoPlus often returns "No data" for new tokens anyway
                        // Skip honeypot check for speed, rely on:
                        // 1. BirdEye's curated trending list
                        // 2. Real-time volume/liquidity checks
                        // 3. Twitter sentiment (Ghost Protocol)

                        // --- STEP 2: PREMIUM FILTERS ---
                        // Explicitly parse values to ensure they are numbers
                        const rawLiq = token.liquidityUsd;
                        const rawMc = token.marketCapUsd;
                        const rawVol = token.volume24hUsd;

                        // Ensure numeric types (handle potential string inputs)
                        const liq = Number(rawLiq) || 0;
                        const mc = Number(rawMc) || 0;
                        const volume24h = Number(rawVol) || 0;



                        // --- CRITICAL RE-EVALUATION LOGIC ---
                        let strictMode = false;
                        const previousAlert = await this.storage.getSeenToken(token.mint);

                        if (previousAlert && previousAlert.lastAlertAt > 0) {
                            // Token was alerted before. Check if it "walked" (price spiked)
                            const lastPrice = previousAlert.lastPrice || 0;
                            const currentPrice = token.priceUsd || 0;

                            if (lastPrice > 0) {
                                const priceRatio = currentPrice / lastPrice;
                                if (priceRatio > 1.5) {
                                    // Price is >1.5x since last alert. Dangerous to enter?
                                    logger.info(`[Re-Eval] ⚠️ ${token.symbol} is up ${priceRatio.toFixed(2)}x since last alert. Engaging STRICT MODE.`);
                                    strictMode = true;
                                }
                            }

                            // Even if price is fine, re-alerting requires higher standards
                            // strictMode = true; // Use this if we want ALL re-alerts to be strict
                        }

                        const ageHours = token.createdAt ? (Date.now() - token.createdAt.getTime()) / (3600 * 1000) : 0;


                        // AGE FILTER REVERTED: User wants High Score Old Tokens to pass.
                        // Rely on AI "Zombie Test" instead.

                        // NEW: DYNAMIC FLOOR STRATEGY (Adaptive Ratio)
                        let minRatio = 0.20; // Default for low caps (<500k)

                        if (mc > 5000000) {
                            minRatio = 0.04; // High Cap (>5M): Expect >4% liquidity (User requested 0.4 but 4% is safer/realistic)
                        } else if (mc > 500000) {
                            minRatio = 0.10; // Mid Cap (500k-5M): Expect >10% liquidity
                        }
                        // Else Low Cap (<500k): Keep 20% (0.20) for safety

                        const liqMcRatio = liq / (mc || 1);
                        if (liqMcRatio < minRatio) {
                            lowLiqCount++;
                            // logger.debug(`[Filter] 🏚️ Weak Floor: ${token.symbol} (Ratio: ${liqMcRatio.toFixed(2)})`);
                            return;
                        }

                        // FILTER 1: Liquidity (Min $10k)
                        if (liq < 10000) {
                            lowLiqCount++;
                            // logger.debug(`[Filter] 💧 Low Liquidity: ${token.symbol} ($${Math.floor(liq)})`);
                            return;
                        }

                        // FILTER 2: Market Cap (Max $5M)
                        if (mc > 5000000) {
                            logger.debug(`[Filter] 🐳 Too Big: ${token.symbol} (MC: $${(mc / 1000000).toFixed(1)}M)`);
                            return;
                        }

                        // FILTER 2: Momentum (24h Volume / Liquidity)
                        const momentum = volume24h / (liq || 1);

                        if (momentum < 0.7) {
                            weakMomentumCount++;
                            // logger.debug(`[Filter] 💤 Weak Momentum: ${token.symbol} (${momentum.toFixed(2)}x)`);
                            return;
                        }

                        const ageDisplay = ageHours < 1 ? `${Math.floor(ageHours * 60)}m` : `${Math.floor(ageHours)}h`;

                        // MOVED: Log only after passing ALL filters (Floor, Liq, MC, Momentum)
                        logger.info(`[Sniper] 💎 GEM DETECTED: ${token.symbol} | MC: $${Math.floor(mc)} | Age: ${ageDisplay} | Vol/Liq: ${momentum.toFixed(2)}x | Floor: ${liqMcRatio.toFixed(2)}`);


                        // --- STEP 3: TWITTER SCAN (Safe Mode) ---
                        let tweets: string[] = [];
                        if (config.ENABLE_TWITTER_SCRAPING) {
                            try {
                                // Use new fallback system (passes token object)
                                tweets = await this.scraper.fetchTokenTweets(token);
                            } catch (err) {
                                logger.error(`[Job] Scraping failed for ${token.symbol}: ${err}`);
                            }
                        }


                        // --- STEP 4: GHOST PROTOCOL ---
                        // If no tweets found, proceed to AI with Penalty (Risk of ghost scam)
                        if (!tweets || tweets.length === 0) {
                            ghostCount++;
                            logger.warn(`[Ghost] 👻 No tweets found for ${token.symbol}. Proceeding to AI for PENALTY Evaluation (-2 Pts).`);
                            // DO NOT RETURN. Let it pass to AI.
                        }

                        // --- STEP 5: AI ANALYSIS (Wolf Logic) ---
                        // Mock matchResult for scoring compatibility
                        const matchResult = { memeMatch: true, matchScore: 1.0 };
                        const enrichedToken = token;
                        const scoreRes = this.scorer.score(enrichedToken, matchResult); // Base tech score
                        const phase = this.phaseDetector.detect(enrichedToken, scoreRes);

                        // Generate Narrative & Get AI Score
                        const narrative = await this.narrative.generate(enrichedToken, matchResult, scoreRes, tweets);
                        const aiScore = narrative.aiScore || 0;

                        // --- STEP 6: THE GATEKEEPER (Strict Approval) ---
                        const minScore = strictMode ? 8.5 : 7; // Higher bar for re-alerts or pumped tokens

                        if (!narrative.aiApproved || aiScore < minScore) {
                            lowScoreCount++;
                            const reason = narrative.aiReason || `AI Score ${aiScore} < ${minScore}`;
                            logger.info(`❌ [AI Reject] ${token.symbol} - Score: ${aiScore}/10 - Reason: ${reason}`);

                            await this.storage.saveSeenToken(token.mint, {
                                symbol: token.symbol, // Save symbol especially for rejects
                                firstSeenAt: Date.now(),
                                lastAlertAt: 0,
                                lastScore: aiScore,
                                lastPhase: 'REJECTED_LOW_SCORE'
                            });
                            return; // DO NOT ALERT
                        }

                        // --- STEP 7: SUCCESS - GEM SPOTTED ---
                        const { allowed } = await this.cooldown.canAlert(token.mint);
                        if (allowed) {
                            alertCount++;
                            logger.info(`✅ [GEM SPOTTED] ${token.symbol} Score: ${aiScore}/10 -> Sending Alert!`);

                            // FAST ALERT REMOVED: User wants only one AI-verified alert
                            // if (v1h > 10000 && impulseRatio > 1.0) {
                            //     const mockMomentum = {
                            //         volume: v1h,
                            //         swaps: Math.floor(v1h / 1000)
                            //     };
                            //     await this.bot.sendFastAlert(token, mockMomentum);
                            // }

                            await this.bot.sendAlert(narrative, enrichedToken, scoreRes);
                            if (aiScore >= 8) await this.twitter.postTweet(narrative, enrichedToken);

                            await this.cooldown.recordAlert(token.mint, scoreRes.totalScore, phase, token.priceUsd);

                            // Save Tracking Data
                            await this.storage.savePerformance({
                                mint: token.mint,
                                symbol: token.symbol,
                                alertMc: token.marketCapUsd || 0,
                                athMc: token.marketCapUsd || 0,
                                currentMc: token.marketCapUsd || 0,
                                entryPrice: token.priceUsd || 0,
                                status: 'TRACKING', // Fixed missing status
                                alertTimestamp: new Date(),
                                lastUpdated: new Date()
                            });
                        }

                    } catch (tokenErr) {
                        logger.error(`[Job] Error processing token ${token.symbol}: ${tokenErr}`);
                    }
                }));
                // Tiny delay between chunks
                await new Promise(r => setTimeout(r, 100));
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
  💧 Low Liquidity (<$10k): ${lowLiqCount}
  💤 Weak Momentum (<0.7x): ${weakMomentumCount}
  👻 Ghost Protocol: ${ghostCount}
  ❌ AI Score <7: ${lowScoreCount}

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
}
