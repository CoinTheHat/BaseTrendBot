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
        const delay = 60000; // 60s Eco-Mode
        logger.info(`[Eco-Mode] Scan complete. Resting for 60s to save API credits...`);
        setTimeout(() => this.runLoop(), delay);
    }

    private async runCycle() {
        if (this.isScanning) {
            logger.warn(`[Job] ⚠️ Cycle skipped - Previous cycle still running.`);
            return;
        }

        this.isScanning = true;

        try {
            logger.info('[Job] Starting scan cycle...');

            // 1. Fetch Candidates (Solana Only - RAYDIUM GRADUATED)
            // We NO LONGER fetch from PumpFun direct. Only BirdEye (which lists Raydium).
            const birdSolTokens = await this.birdeye.fetchNewListings('solana', 20);

            logger.info(`🦅 Scanning Solana (Raydium Only) - Filter: Min Liq $5k...`);

            // Deduplicate (Though now we only have one source, good practice to keep unique logic)
            const allTokens = [...birdSolTokens];
            const uniqueTokens: Record<string, TokenSnapshot> = {};
            allTokens.forEach(t => uniqueTokens[t.mint] = t);
            const candidates = Object.values(uniqueTokens);

            // Filter Fresh Tokens
            const now = Date.now();
            const freshCandidates: TokenSnapshot[] = [];
            for (const token of candidates) {
                const lastProcessed = this.processedCache.get(token.mint);
                // ANTI-SPAM: Ignore if seen in last 15 mins (900,000ms)
                if (lastProcessed && (now - lastProcessed < 15 * 60 * 1000)) continue;
                freshCandidates.push(token);
            }

            if (freshCandidates.length === 0) {
                // logger.info(`[Job] No fresh tokens to process.`); // Silence "No tokens" spam too
                return;
            }

            logger.info(`[Job] Processing ${freshCandidates.length} potential trending tokens...`);

            // Process in chunks
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (token) => {
                    try {
                        // Mark as seen immediately to prevent re-processing in next cycle
                        this.processedCache.set(token.mint, Date.now());

                        // --- STEP 1: HONEYPOT CHECK ---
                        const chain = token.mint.startsWith('0x') ? 'base' : 'solana';
                        const isSafe = await this.goPlus.checkToken(token.mint, chain);
                        if (!isSafe) {
                            // logger.warn(`[Security] 🚨 HONEYPOT DETECTED: ${token.symbol}. SKIP.`);
                            return;
                        }

                        // --- STEP 2: SNIPER PRE-FILTERS (Hard Gate) ---
                        // We filter BEFORE Twitter/AI to save resources.

                        const liq = token.liquidityUsd || 0;
                        // Use 5m Volume, fallback to 1% of 24h volume if missing
                        const v5m = token.volume5mUsd || ((token.volume24hUsd || 0) / 100);

                        // RULE A: Liquidity Floor ($5,000) - HANDLED BY API NOW
                        // Doubling check just in case API allows slight variance
                        if (liq < 5000) return;

                        // RULE B: MOMENTUM (5m Volume > $5k)
                        // This ensures the token is MOVING NOW.
                        if (v5m < 5000) {
                            // logger.debug(`[Filter] Low 5m Vol: ${token.symbol} ($${Math.floor(v5m)}). Skip.`);
                            return;
                        }

                        const impulseRatio = v5m / (liq || 1);
                        if (impulseRatio < 0.1) { // Relaxed ratio since we have hard volume floor
                            return;
                        }

                        logger.info(`[Sniper] 🎯 TRENDING DETECTED: ${token.symbol} | Liq: $${Math.floor(liq)} | 5m Vol: $${Math.floor(v5m)}`);

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
                            const reason = narrative.aiReason || "Score < 7";
                            logger.info(`❌ Rejected [Score: ${aiScore}] - ${token.symbol} - Reason: ${reason}`);

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
                            logger.info(`💎 [GEM SPOTTED] ${token.symbol} Score: ${aiScore} -> Sending Alert!`);

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
                                status: 'TRACKING',
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
