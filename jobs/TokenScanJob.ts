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
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();

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
        logger.info(`[Job] Token Scan Job started. Interval: ${config.SCAN_INTERVAL_SECONDS}s`);

        // Initial run
        this.runCycle();

        setInterval(() => this.runCycle(), config.SCAN_INTERVAL_SECONDS * 1000);
    }

    private async runCycle() {
        try {
            logger.info('[Job] Starting scan cycle...');
            // const state = this.storage.load(); // JSON Storage removed

            // 1. Fetch
            // a. Get Watchlist tokens (ACTIVE TRACKING)
            const watchlistItems = this.matcher.getWatchlistItems();
            const watchlistMints = watchlistItems
                .filter(i => i.phrase.length > 30 && !i.phrase.includes(' ')) // Simple CA check
                .map(i => i.phrase);

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

            for (const token of candidates) {
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
                        alphaResult = await this.alphaSearch.checkAlpha(token.symbol);

                        if (alphaResult.isEarlyAlpha) {
                            const isSuper = alphaResult.isSuperAlpha;
                            matchResult = {
                                memeMatch: true,
                                matchedMeme: { id: 'alpha', phrase: isSuper ? 'High Momentum' : 'Rising Velocity', tags: ['ALPHA'], createdAt: new Date() },
                                matchScore: isSuper ? 0.95 : 0.85
                            };
                            logger.info(`[Discovery] 🔥 ${isSuper ? 'SUPER' : 'EARLY'} ALPHA DETECTED: ${token.symbol} (Unique: ${alphaResult.uniqueAuthors}, Velocity: ${alphaResult.velocity})`);
                        }
                    }
                }

                // Strategy: Only deeper process if meme matches OR is Alpha
                if (!matchResult.memeMatch) continue;

                logger.info(`[Discovery] MATCH: ${token.symbol} matches '${matchResult.matchedMeme?.phrase}'`);

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
                        // Generate Narrative
                        const narrative = this.narrative.generate(enrichedToken, matchResult, scoreRes);

                        // 7. Twitter Scraping / Alpha Data integration
                        if (config.ENABLE_TWITTER_SCRAPING) {
                            try {
                                if (alphaResult && alphaResult.isEarlyAlpha) {
                                    // Use Alpha Tweets
                                    const story = this.storyEngine.buildStory(enrichedToken, alphaResult.tweets, false);
                                    story.potentialCategory = alphaResult.isSuperAlpha ? "SUPER_ALPHA" : "EARLY_ALPHA";
                                    narrative.twitterStory = story;
                                    logger.info(`[Job] Added ${story.potentialCategory} Story: ${story.summary}`);
                                } else {
                                    // Regular Scraping (Slow) for other matches
                                    logger.info(`[Job] Scraping Twitter for ${enrichedToken.symbol}...`);
                                    const queries = QueryBuilder.build(enrichedToken.name, enrichedToken.symbol);
                                    const tweets = await this.scraper.fetchTokenTweets(queries);

                                    if (tweets.length > 0) {
                                        // Check if trend match
                                        const isTrend = trendMatchMap.has(token.mint);
                                        const story = this.storyEngine.buildStory(enrichedToken, tweets, isTrend);
                                        narrative.twitterStory = story;
                                        logger.info(`[Job] Added Twitter Story: ${story.summary}`);
                                    }
                                }
                            } catch (err) {
                                logger.error(`[Job] Scraping failed for ${enrichedToken.symbol}: ${err}`);
                            }
                        }

                        // Send Alerts
                        await this.bot.sendAlert(narrative, enrichedToken, scoreRes);
                        await this.twitter.postTweet(narrative, enrichedToken);

                        // Update State (Cooldown manager handles saving)
                        await this.cooldown.recordAlert(enrichedToken.mint, scoreRes.totalScore, phase);

                        logger.info(`[Job] Alerted for ${token.symbol}. Cooldown active.`);
                    } else {
                        logger.info(`[Job] Skipped alert for ${token.symbol}: ${reason}`);
                    }
                }
            }

        } catch (err) {
            logger.error(`[Job] Cycle failed: ${err}`);
        }
    }
}
