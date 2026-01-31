import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { PumpFunService } from '../services/PumpFunService';
import { BirdeyeService } from '../services/BirdeyeService';
import { GoPlusService } from '../services/GoPlusService';
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

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();
    private processedCache = new Map<string, number>();

    constructor(
        private pumpFun: PumpFunService,
        private birdeye: BirdeyeService,
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
        private alphaSearch: AlphaSearchService,
        private goPlus: GoPlusService
    ) { }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`[Job] Token Scan Job started. Interval: 60s (Sniper Mode)`);
        this.runLoop();
    }

    private async runLoop() {
        if (!this.isRunning) return;
        await this.runCycle();
        const delay = 120000; // 2 Minutes (Premium Interval)
        logger.info(`[Premium-Mode] Scan complete. Resting for 120s...`);
        setTimeout(() => this.runLoop(), delay);
    }

    private async runCycle() {
        if (this.isScanning) {
            logger.warn(`[Job] ⚠️ Cycle skipped - Previous cycle still running.`);
            return;
        }

        this.isScanning = true;

        try {
            logger.info('[Job] Starting V3 Trending Scan...');

            // 1. Fetch Candidates (Trending V3)
            const birdSolTokens = await this.birdeye.fetchTrendingTokens('solana');
            logger.info(`[Fetch] 📡 Received ${birdSolTokens.length} tokens from BirdEye V3`);

            const freshCandidates: TokenSnapshot[] = [];
            const now = Date.now();
            let cachedCount = 0;

            for (const token of birdSolTokens) {
                const lastProcessed = this.processedCache.get(token.mint);
                // ANTI-SPAM: Ignore if seen in last 15 mins
                if (lastProcessed && (now - lastProcessed < 15 * 60 * 1000)) {
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
            let honeypotCount = 0;
            let lowLiqCount = 0;
            let lowVolCount = 0;
            let weakMomentumCount = 0;
            let ghostCount = 0;
            let lowScoreCount = 0;
            let alertCount = 0;

            // Process in chunks
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (token) => {
                    try {
                        this.processedCache.set(token.mint, Date.now());

                        // --- STEP 1: HONEYPOT CHECK ---
                        const chain = token.mint.startsWith('0x') ? 'base' : 'solana';
                        const isSafe = await this.goPlus.checkToken(token.mint, chain);
                        if (!isSafe) {
                            honeypotCount++;
                            logger.warn(`[Security] 🚨 HONEYPOT: ${token.symbol}`);
                            return;
                        }

                        // --- STEP 2: PREMIUM FILTERS ---
                        // Liquidity > 5k (Handled by API Fallback / Implicit in Trending)
                        // Volume 5m > 5k

                        const liq = token.liquidityUsd || 0;
                        const v5m = token.volume5mUsd || ((token.volume24hUsd || 0) / 100);

                        // Double check Liq
                        if (liq < 5000) {
                            lowLiqCount++;
                            logger.debug(`[Filter] 💧 Low Liquidity: ${token.symbol} ($${Math.floor(liq)})`);
                            return;
                        }

                        // VOLUME FILTER (Floor)
                        if (v5m < 5000) {
                            lowVolCount++;
                            logger.debug(`[Filter] 📊 Low 5m Volume: ${token.symbol} ($${Math.floor(v5m)})`);
                            return;
                        }

                        // RULE B: MOMENTUM IMPULSE (The 1.5x Rule)
                        // Volume in last 5m MUST be > 1.5x Liquidity to prove breakout.
                        // User Request: "Son 5 dakikada en az $5,000 bunu likiditenin 1.5 katı yapmıştık"
                        const impulseRatio = v5m / (liq || 1);
                        if (impulseRatio < 1.5) {
                            weakMomentumCount++;
                            logger.debug(`[Filter] 💤 Weak Momentum: ${token.symbol} (${impulseRatio.toFixed(2)}x, needs >1.5x)`);
                            return;
                        }

                        logger.info(`[Sniper] 💎 GEM DETECTED (V3): ${token.symbol} | Liq: $${Math.floor(liq)} | 5m Vol: $${Math.floor(v5m)} (Ratio: ${impulseRatio.toFixed(2)}x)`);

                        // --- STEP 2.5: HIGH-SPEED MOMENTUM CHECK (Ultra-Hot) ---
                        // Check exact 5m TXs to validate "Rush"
                        const momentum = await this.birdeye.getTokenMomentum(token.mint, 'solana');
                        if (momentum.isHot) {
                            await this.bot.sendFastAlert(token, momentum);
                        }

                        // --- STEP 3: TWITTER SCAN (Safe Mode) ---
                        let tweets: string[] = [];
                        if (config.ENABLE_TWITTER_SCRAPING) {
                            try {
                                const queries = QueryBuilder.build(token.name, token.symbol);
                                // Fetch exactly 20 tweets using single account logic (handled in scraper)
                                tweets = await this.scraper.fetchTokenTweets(queries);
                            } catch (err) {
                                logger.error(`[Job] Scraping failed for ${token.symbol}: ${err}`);
                            }
                        }

                        // --- STEP 4: GHOST PROTOCOL ---
                        // If no tweets found, Auto-Reject (Risk of ghost scam)
                        if (!tweets || tweets.length === 0) {
                            ghostCount++;
                            logger.warn(`[Ghost] 👻 No tweets found for ${token.symbol}. Auto-Rejecting (Score: 4).`);

                            await this.storage.saveSeenToken(token.mint, {
                                firstSeenAt: Date.now(),
                                lastAlertAt: 0,
                                lastScore: 4,
                                lastPhase: 'REJECTED_GHOST'
                            });
                            return; // STOP HERE
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

                        // --- STEP 6: THE GATEKEEPER (Strict < 7 Reject) ---
                        if (aiScore < 7) {
                            lowScoreCount++;
                            const reason = narrative.aiReason || "Score < 7";
                            logger.info(`❌ [AI Reject] ${token.symbol} - Score: ${aiScore}/10 - Reason: ${reason}`);

                            await this.storage.saveSeenToken(token.mint, {
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
            const totalRejected = honeypotCount + lowLiqCount + lowVolCount + weakMomentumCount + ghostCount + lowScoreCount;
            logger.info(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 [SCAN SUMMARY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Total Fetched: ${birdSolTokens.length}
🔄 Cached (15m): ${cachedCount}
🎯 Fresh Candidates: ${freshCandidates.length}

🚫 REJECTED (${totalRejected}):
  🚨 Honeypot: ${honeypotCount}
  💧 Low Liquidity (<$5k): ${lowLiqCount}
  📊 Low Volume (<$5k): ${lowVolCount}
  💤 Weak Momentum (<1.5x): ${weakMomentumCount}
  👻 Ghost Protocol: ${ghostCount}
  ❌ AI Score <7: ${lowScoreCount}

✅ ALERTS SENT: ${alertCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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
