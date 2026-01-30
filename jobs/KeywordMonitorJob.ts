import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterTrendsService } from '../trends/TwitterTrendsService';
import { LLMService } from '../services/LLMService';

export class KeywordMonitorJob {
    private job: CronJob;
    // Updated Query: Filter retweets/airdrops, look for broader tech keywords
    private readonly QUERY = '("ERC-8004" OR "ERC8004" OR "Hybrid Token") -is:retweet -airdrop -giveaway';

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

                // Content Check: Must have Cashtag OR CA OR High Engagement (>20 Likes)
                // (Lowered threshold from 50 to 20 to catch early alpha)
                const hasCashtag = /\$[a-zA-Z]{2,}/.test(t.text);
                const hasCA = /0x[a-fA-F0-9]{40}/.test(t.text);
                const isHighEng = (t.metrics?.like_count || 0) > 20;

                if (hasCashtag || hasCA || isHighEng) {
                    uniqueTweets.set(t.text, t);
                }
            }

            const candidates = Array.from(uniqueTweets.values());
            if (candidates.length === 0) {
                logger.info('[KeywordMonitor] No candidates passed pre-filter.');
                return;
            }

            logger.info(`[KeywordMonitor] Sending ${candidates.length} candidates to AI...`);

            // 3. BATCH ANALYSIS (The Brain)
            const results = await this.llmService.analyzeTrendBatch(
                candidates.map(c => c.text),
                candidates.map(c => c.tweetId)
            );

            // 4. NOTIFICATION (The Gem)
            for (const gem of results) {
                // Check if we already alerted this tweet to allow "new news" about "same project"
                // But avoid same tweet ID.
                const isProcessed = await this.storage.hasSeenKeywordTweet(gem.sourceTweetId);
                if (isProcessed) continue;

                const msg = `💎 **AI SEÇKİSİ: ERC-8004 FIRSATLARI**\n\n` +
                    `🔹 **Proje:** ${gem.projectName}\n` +
                    `📊 **AI Yorumu:** ${gem.summary} (Güven: %${gem.confidenceScore})\n` +
                    `🔗 **Kaynak:** [Tweet Linki](https://x.com/i/web/status/${gem.sourceTweetId})\n\n` +
                    `⚠️ *DYOR - Erken Aşama Teknik Trend*`;

                await this.telegram.notifyAdmin(msg);
                await this.storage.saveKeywordTweet(gem.sourceTweetId, gem.projectName, gem.summary);
            }

        } catch (error) {
            logger.error('[KeywordMonitor] Error running job:', error);
        }
    }
}
