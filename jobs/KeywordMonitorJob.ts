import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterTrendsService } from '../trends/TwitterTrendsService';
import { LLMService } from '../services/LLMService';

export class KeywordMonitorJob {
    private job: CronJob;
    // Updated Query: Filter retweets, replies, airdrops, enforce min likes
    private readonly QUERY = '("ERC-8004" OR "ERC8004" OR "Hybrid Token") -is:retweet -is:reply -airdrop -giveaway min_faves:5';

    constructor(
        private storage: PostgresStorage,
        private telegram: ScandexBot,
        private twitterService: TwitterTrendsService,
        private llmService: LLMService
    ) {
        // Run every 15 minutes
        this.job = new CronJob('*/15 * * * *', async () => {
            await this.run();
        });
    }

    start() {
        logger.info('[KeywordMonitor] Job started (Jeweler Mode). Watching: ERC-8004 & Hybrid Tokens');
        this.job.start();
        this.run(); // Initial run
    }

    private async run() {
        try {
            logger.info('[KeywordMonitor] Harvesting tweets...');

            // 1. HARVESTING (100 Tweets)
            const tweets = await this.twitterService.searchRecentTweets(this.QUERY, 100);
            if (tweets.length === 0) return;

            // 2. PRE-FILTERING (The Sieve)
            const uniqueTweets = new Map<string, any>();

            for (const t of tweets) {
                // Dup check
                if (uniqueTweets.has(t.text)) continue;

                // Content Check: Must have Cashtag OR CA
                // (High engagement check is already handled by API query min_faves:5)
                const hasCashtag = /\$[a-zA-Z]{2,}/.test(t.text);
                const hasCA = /0x[a-fA-F0-9]{40}/.test(t.text);

                if (hasCashtag || hasCA) {
                    uniqueTweets.set(t.text, { id: t.tweetId, text: t.text });
                }
            }

            const candidates = Array.from(uniqueTweets.values());
            if (candidates.length === 0) {
                logger.info('[KeywordMonitor] No candidates passed pre-filter.');
                return;
            }

            logger.info(`[KeywordMonitor] Sending ${candidates.length} candidates to Batch AI...`);

            // 3. BATCH ANALYSIS (The Brain)
            const results = await this.llmService.analyzeTweetBatch(candidates);

            // 4. NOTIFICATION (The Gem)
            for (const gem of results) {
                // Fallback if source_id missing (should not happen with new prompt)
                const sourceId = gem.source_id || candidates[0].id;

                // Check dup
                const isProcessed = await this.storage.hasSeenKeywordTweet(sourceId);
                if (isProcessed) continue;

                const msg = `💎 **AI KUYUMCUSU: ERC-8004 FIRSATI**\n\n` +
                    `🔹 **Token:** ${gem.symbol}\n` +
                    `🧠 **Grok Puanı:** ${gem.sentiment}/10\n` +
                    `📝 **Analiz:** ${gem.reason}\n\n` +
                    `🔗 **Kaynak:** [Tweet Linki](https://x.com/i/web/status/${sourceId})\n` +
                    `⚠️ *Otomatik analizdir, DYOR.*`;

                await this.telegram.notifyAdmin(msg);
                await this.storage.saveKeywordTweet(sourceId, gem.symbol, gem.reason);
            }

        } catch (error) {
            logger.error('[KeywordMonitor] Error running job:', error);
        }
    }
}
