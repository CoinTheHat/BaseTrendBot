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
        private trendMatcher: TrendTokenMatcher
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
            const [pumpTokens, dexTokens] = await Promise.all([
                this.pumpFun.getNewTokens(),
                this.dexScreener.getLatestPairs()
            ]);

            // Deduplicate by mint
            const allTokens = [...pumpTokens, ...dexTokens];
            const uniqueTokens: Record<string, TokenSnapshot> = {};
            allTokens.forEach(t => uniqueTokens[t.mint] = t);
            const candidates = Object.values(uniqueTokens);

            logger.info(`[Job] Fetched ${candidates.length} tokens.`);

            // Get Active Trends for matching
            const topTrends = this.trendCollector.getTopTrends(5);
            const trendMatches = this.trendMatcher.matchTrends(topTrends, candidates);
            // Map matches to token mints for quick lookup
            const trendMatchMap = new Set<string>();
            trendMatches.forEach((tm: any) => tm.tokens.forEach((t: any) => trendMatchMap.add(t.snapshot.mint)));

            for (const token of candidates) {
                // 2. Meme Match
                let matchResult = this.matcher.match(token);

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

                // Strategy: Only deeper process if meme matches OR if we want to track high volume regardless (V1: Meme Focused)
                if (!matchResult.memeMatch) continue;

                logger.info(`[Discovery] MATCH: ${token.symbol} matches '${matchResult.matchedMeme?.phrase}'`);

                // 3. Enrich (Birdeye) - selectively
                const [enrichedToken] = await this.birdeye.enrichTokens([token]);

                // 4. Score
                const scoreRes = this.scorer.score(enrichedToken, matchResult);

                // 5. Phase
                // Pass scoreRes to detect... wait, PhaseDetector.detect(token, scoreRes)
                const phase = this.phaseDetector.detect(enrichedToken, scoreRes);
                scoreRes.phase = phase; // Update score result with final phase

                // 6. Alert Check
                if (scoreRes.totalScore >= config.ALERT_SCORE_THRESHOLD) {
                    // Check Cooldown
                    const { allowed, reason } = await this.cooldown.canAlert(enrichedToken.mint);

                    if (allowed) {
                        // Generate Narrative
                        const narrative = this.narrative.generate(enrichedToken, matchResult, scoreRes);

                        // 7. Twitter Scraping (Enrichment)
                        if (config.ENABLE_TWITTER_SCRAPING) {
                            try {
                                logger.info(`[Job] Scraping Twitter for ${enrichedToken.symbol}...`);
                                const queries = QueryBuilder.build(enrichedToken.name, enrichedToken.symbol);
                                const tweets = await this.scraper.fetchTokenTweets(queries);

                                if (tweets.length > 0) {
                                    const story = this.storyEngine.buildStory(enrichedToken, tweets);
                                    narrative.twitterStory = story;
                                    logger.info(`[Job] Added Twitter Story: ${story.summary}`);
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
