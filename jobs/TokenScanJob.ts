import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { PumpFunService } from '../services/PumpFunService';
import { DexScreenerService } from '../services/DexScreenerService';
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

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();
    private processedCache = new Map<string, number>(); // Cache to store processed tokens (Mint -> Timestamp)


    constructor(
        private pumpFun: PumpFunService,
        private dexScreener: DexScreenerService,
        private birdeye: BirdeyeService,
        private matcher: Matcher,
        private scorer: ScoringEngine,
        private phaseDetector: PhaseDetector,
        private cooldown: CooldownManager,
        private narrative: NarrativeEngine,
        private bot: ScandexBot,
        private twitter: TwitterPublisher,
        private storage: PostgresStorage, // Updated type
        private trendCollector: TrendCollector,
        private trendMatcher: TrendTokenMatcher,
        private alphaSearch: AlphaSearchService
    ) { }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        // Use 90s + Random Jitter to avoid bot detection
        logger.info(`[Job] Token Scan Job started. Interval: ~90s (Jitter Active)`);

        // Start Loop
        this.runLoop();
    }

    private async runLoop() {
        if (!this.isRunning) return;

        await this.runCycle();

        // Calculate Next Run: 90s + random(0-10s)
        const baseInterval = 90 * 1000;
        const jitter = Math.random() * 10000;
        const delay = baseInterval + jitter;

        logger.info(`[Job] 💤 Sleeping for ${(delay / 1000).toFixed(1)}s...`);

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
            // const state = this.storage.load(); // JSON Storage removed

            // 1. Fetch
            // a. Get Watchlist tokens (ACTIVE TRACKING)
            const watchlistItems = this.matcher.getWatchlistItems();
            const watchlistMints = watchlistItems
                .filter(i => i.phrase.length > 30 && !i.phrase.includes(' ')) // Simple CA check
                .map(i => i.phrase);

            if (watchlistMints.length > 0) {
                logger.info(`[Job] Tracking ${watchlistMints.length} Watchlist CAs: ${watchlistMints.join(', ')}`);
            }

            // b. Execute fetches in parallel
            const [pumpTokens, dexTokens, birdTokens, watchlistTokens] = await Promise.all([
                this.pumpFun.getNewTokens(),
                this.dexScreener.getLatestPairs(),
                this.birdeye.getNewTokens(10),
                watchlistMints.length > 0 ? this.dexScreener.getTokens(watchlistMints) : Promise.resolve([])
            ]);

            // Deduplicate by mint
            const allTokens = [...pumpTokens, ...dexTokens, ...birdTokens, ...watchlistTokens];
            const uniqueTokens: Record<string, TokenSnapshot> = {};
            allTokens.forEach(t => uniqueTokens[t.mint] = t);
            const candidates = Object.values(uniqueTokens);

            logger.info(`[Job] Fetched ${candidates.length} tokens.`);

            // Get Active Trends for matching
            let topTrends = this.trendCollector.getTopTrends(20); // Increase limit for better matching chance

            // Auto-Refresh if empty (Startup/Stale state fix)
            if (topTrends.length === 0) {
                logger.info('[Job] Trends list empty. Forcing refresh...');
                topTrends = await this.trendCollector.refresh();
            }
            const trendMatches = this.trendMatcher.matchTrends(topTrends, candidates);
            // Map matches to token mints for quick lookup
            const trendMatchMap = new Set<string>();
            trendMatches.forEach((tm: any) => tm.tokens.forEach((t: any) => trendMatchMap.add(t.snapshot.mint)));

            // Filter out recently processed tokens
            const now = Date.now();
            const freshCandidates: TokenSnapshot[] = [];

            for (const token of candidates) {
                const lastProcessed = this.processedCache.get(token.mint);
                // 10 minutes cache
                if (lastProcessed && (now - lastProcessed < 10 * 60 * 1000)) {
                    // logger.info(`[Job] Skipping ${token.symbol} - Already processed recently.`);
                    continue;
                }
                freshCandidates.push(token);
            }

            if (freshCandidates.length === 0) {
                logger.info(`[Job] No fresh tokens to process (All cached).`);
                return;
            }

            logger.info(`[Job] Processing ${freshCandidates.length} fresh tokens (Parallel Batches)...`);

            // ⚠️ PRE-FETCH ALPHA (BATCH MODE) ⚠️
            // Identify tokens that need Twitter Scan (Stricter Filters)
            // Identify tokens that need Twitter Scan (Smart Resource Management)
            // ⚠️ GOURMET FILTER (High Conviction Only) ⚠️
            const alphaCandidates = freshCandidates.filter(t => {
                const vol5m = t.volume5mUsd || 0;
                const liq = t.liquidityUsd || 0;
                const mc = t.marketCapUsd || 1; // Avoid divide by zero

                // 1. Strict Liquidity Floor: $15,000 (Avoid Micro-Caps)
                const isLiquid = liq > 15000;

                // 2. Volume/MC Ratio: > 20% (Must have real velocity, not just static MC)
                const volumeRatio = vol5m / mc;
                const isHighVelocity = volumeRatio > 0.20;

                // EXCEPTIONAL CASE: If Volume 5m > $50k, pass regardless of MC ratio (Whale Ape)
                const isWhaleVolume = vol5m > 50000;

                return isLiquid && (isHighVelocity || isWhaleVolume);
            });

            const alphaMap = new Map<string, any>();

            if (alphaCandidates.length > 0) {
                // logger.info(`[Job] Batch Scanning ${alphaCandidates.length} tokens for Alpha Signals...`);

                // This triggers the Multi-Worker, Multi-Account, Sequential Batch Logic
                // NOW PASSING OBJECTS for Single Shot Logic
                const batchResults = await this.alphaSearch.scanBatch(alphaCandidates.map(t => ({ symbol: t.symbol, name: t.name })));
                // Copy to map
                batchResults.forEach((val, key) => alphaMap.set(key, val));
            }


            // Creates chunks of 2 (Reduced from 5 to avoid rate limits)
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                // logger.info(`[Job] Processing batch of ${chunk.length} tokens: ${chunk.map(t => t.symbol).join(', ')}`);

                await Promise.all(chunk.map(async (token) => {
                    try {
                        // --- BIRDEYE FALLBACK LOGIC START ---
                        if (token.symbol === 'UNKNOWN' || token.name === 'Unknown Token' || !token.symbol) {
                            try {
                                console.log(`[BirdEye] Attempting to fix UNKNOWN token: ${token.mint}`);
                                const metadata = await this.birdeye.getTokenMetadata(token.mint);

                                if (metadata) {
                                    token.symbol = metadata.symbol;
                                    token.name = metadata.name;
                                    console.log(`[BirdEye] ✅ FIXED: ${token.mint} is ${token.symbol}`);
                                } else {
                                    console.log(`[BirdEye] ❌ Could not find metadata for ${token.mint}`);
                                }
                            } catch (error: any) {
                                console.log(`[BirdEye] API Error: ${error.message}`);
                            }
                        }
                        // --- BIRDEYE FALLBACK LOGIC END ---

                        // Mark as processed immediately to prevent re-entry in race conditions
                        this.processedCache.set(token.mint, Date.now());

                        // 2. Meme Match
                        let matchResult = this.matcher.match(token);
                        let alphaResult = null;

                        // Auto-Trend Match Fallback
                        if (!matchResult.memeMatch && trendMatchMap.has(token.mint)) {
                            // Find which trend it matched
                            const matchingTrend = trendMatches.find((tm: any) => tm.tokens.some((t: any) => t.snapshot.mint === token.mint))?.trend;
                            if (matchingTrend) {
                                matchResult = {
                                    memeMatch: true,
                                    matchedMeme: { id: matchingTrend.id, phrase: matchingTrend.phrase, tags: ['TRENDING'], createdAt: new Date() },
                                    matchScore: 0.9
                                };
                                logger.info(`[Discovery] 🛸 AUTO-TREND DETECTED: ${token.symbol} matches social trend '${matchingTrend.phrase}'`);
                            }
                        }

                        // 3. Alpha Hunter Trigger (Early Momentum)
                        if (!matchResult.memeMatch) {
                            const vol = token.volume30mUsd || 0;
                            const liq = token.liquidityUsd || 0;

                            // Stricter Threads: >$15k Volume, >$5k Liquidity (Avoid Rugs)
                            if (vol > 15000 && liq > 5000) {
                                // USE BATCH RESULT
                                alphaResult = alphaMap.get(token.symbol);

                                if (alphaResult && alphaResult.isEarlyAlpha) {
                                    const isSuper = alphaResult.isSuperAlpha;
                                    matchResult = {
                                        memeMatch: true,
                                        matchedMeme: { id: 'alpha', phrase: isSuper ? 'High Momentum' : 'Rising Velocity', tags: ['ALPHA'], createdAt: new Date() },
                                        matchScore: isSuper ? 0.95 : 0.85
                                    };
                                    logger.info(`[Discovery] 🔥 ${isSuper ? 'SUPER' : 'EARLY'} ALPHA DETECTED: ${token.symbol} (Unique: ${alphaResult.uniqueAuthors}, Velocity: ${alphaResult.velocity})`);
                                } else {
                                    // FALLBACK: Tech Trigger
                                    // If we are here, it means Vol/Liq are good, but Twitter failed or is silent.
                                    // We PASS it as a purely technical play.
                                    matchResult = {
                                        memeMatch: true,
                                        matchedMeme: { id: 'technical', phrase: 'High Volume (No Socials)', tags: ['TECHNICAL'], createdAt: new Date() },
                                        matchScore: 0.85
                                    };
                                    logger.info(`[Discovery] ⚠️ TECH FALLBACK: ${token.symbol} has High Volume but no Social Match.`);
                                }
                            }
                        }

                        // Strategy: Only deeper process if meme matches OR is Alpha
                        if (!matchResult.memeMatch) return;

                        // logger.info(`[Discovery] MATCH: ${token.symbol} matches '${matchResult.matchedMeme?.phrase}'`);

                        // 3. Enrich (Birdeye) - selectively
                        const [enrichedToken] = await this.birdeye.enrichTokens([token]);

                        // 4. Score
                        const scoreRes = this.scorer.score(enrichedToken, matchResult);

                        // 5. Phase
                        const phase = this.phaseDetector.detect(enrichedToken, scoreRes);
                        scoreRes.phase = phase; // Update score result with final phase

                        // 6. Alert Check
                        if (scoreRes.totalScore >= config.ALERT_SCORE_THRESHOLD) {
                            // Check Cooldown
                            // VIP Rule: If it's a specific Contract Address match (Watchlist), significantly reduce cooldown for testing/tracking.
                            let customCooldown = undefined;
                            if (matchResult.memeMatch && matchResult.matchedMeme?.phrase === enrichedToken.mint) {
                                customCooldown = 0.5; // 30 seconds for specific CA matches
                            }

                            const { allowed, reason } = await this.cooldown.canAlert(enrichedToken.mint, customCooldown);

                            if (allowed) {
                                // 🛡️ TOO LATE CHECK (Price Flight Protection)
                                const passedToken = await this.storage.getSeenToken(enrichedToken.mint);
                                if (enrichedToken.priceUsd && passedToken && passedToken.lastPrice) {
                                    const entry = passedToken.lastPrice;
                                    // 50% Limit
                                    if (enrichedToken.priceUsd > entry * 1.5) {
                                        logger.warn(`[TooLate] Aborted ${enrichedToken.symbol}. Price ($${enrichedToken.priceUsd}) > 1.5x Entry ($${entry}). Flown.`);
                                        return;
                                    }
                                }

                                // 7. Twitter Scraping (Data Gathering)
                                let tweets: string[] = [];
                                if (config.ENABLE_TWITTER_SCRAPING) {
                                    try {
                                        if (alphaResult && alphaResult.isEarlyAlpha) {
                                            tweets = alphaResult.tweets;
                                            logger.info(`[Job] Using ${tweets.length} Alpha tweets for analysis.`);
                                        } else {
                                            // logger.info(`[Job] Scraping Twitter for ${enrichedToken.symbol}...`);
                                            const queries = QueryBuilder.build(enrichedToken.name, enrichedToken.symbol);
                                            tweets = await this.scraper.fetchTokenTweets(queries);
                                        }
                                    } catch (err) {
                                        logger.error(`[Job] Scraping failed for ${enrichedToken.symbol}: ${err}`);
                                    }
                                }

                                if (!tweets || tweets.length === 0) {
                                    logger.info(`[Job] No Twitter data for ${enrichedToken.symbol}. Proceeding with Volume/Trend scoring...`);
                                }

                                // PRE-FILTER: Delegated to NarrativeEngine (which handles score=2 logic)
                                // We proceed to generate narrative even if low quality, so we can save the 'REJECTED' state.

                                // Generate Narrative (Async, with AI Analysis if tweets exist)
                                const narrative = await this.narrative.generate(enrichedToken, matchResult, scoreRes, tweets);

                                // Attach specific flags if needed (Alpha, etc.)
                                if (alphaResult && alphaResult.isEarlyAlpha) {
                                    if (alphaResult.isSuperAlpha) narrative.narrativeText = "🚀 **SUPER ALPHA — HIGH MOMENTUM** 🚀\n" + narrative.narrativeText;
                                }

                                // 🛡️ GOURMET GATEKEEPER: AI Score Check
                                const aiScore = narrative.aiScore;
                                const vibeCheck = narrative.vibeCheck || '';

                                // CRITICAL: Block if AI is still analyzing or score is invalid
                                if (!aiScore || aiScore === 0 || vibeCheck.includes('Analyzing') || vibeCheck.includes('analiz')) {
                                    logger.warn(`[BLOCKED] ${enrichedToken.symbol} - AI analysis incomplete. Vibe: ${vibeCheck}`);
                                    return; // Skip this token completely
                                }

                                // GOURMET THRESHOLD: Only send to Telegram if Score >= 7
                                if (aiScore < 7) {
                                    const reason = narrative.aiReason ? narrative.aiReason.substring(0, 50) + "..." : "Score < 7 (Gourmet Filter)";
                                    logger.info(`[SILENT] ${enrichedToken.symbol} processed but rejected. Score: ${aiScore}/10 | Reason: ${reason}`);

                                    // Save to DB (Silent Process)
                                    await this.storage.saveSeenToken(enrichedToken.mint, {
                                        firstSeenAt: Date.now(),
                                        lastAlertAt: 0,
                                        lastScore: aiScore,
                                        lastPhase: 'REJECTED_LOW_SCORE'
                                    });
                                } else {
                                    // PASSED: Score is valid and >= 7 (High Conviction)
                                    await this.bot.sendAlert(narrative, enrichedToken, scoreRes);
                                    if (aiScore >= 8) await this.twitter.postTweet(narrative, enrichedToken); // Only tweet absolute bangers
                                    await this.cooldown.recordAlert(enrichedToken.mint, scoreRes.totalScore, phase, enrichedToken.priceUsd);

                                    // RECORD PERFORMANCE
                                    await this.storage.savePerformance({
                                        mint: enrichedToken.mint,
                                        symbol: enrichedToken.symbol,
                                        alertMc: enrichedToken.marketCapUsd || 0,
                                        athMc: enrichedToken.marketCapUsd || 0,
                                        currentMc: enrichedToken.marketCapUsd || 0,
                                        status: 'TRACKING',
                                        alertTimestamp: new Date(),
                                        lastUpdated: new Date()
                                    });

                                    logger.info(`[PASSED] ${enrichedToken.symbol} SENT to Telegram. AI Score: ${aiScore} (Gourmet Mode)`);
                                }
                            } else {
                                logger.info(`[Job] Skipped alert for ${token.symbol}: ${reason}`);
                            }
                        }
                    } catch (tokenErr) {
                        logger.error(`[Job] Error processing token ${token.symbol}: ${tokenErr}`);
                    }
                }));

                // Optional: Tiny delay between chunks to be nice to APIs (100ms)
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
        for (let i = 0; i < arr.length; i += size) {
            res.push(arr.slice(i, i + size));
        }
        return res;
    }
}
