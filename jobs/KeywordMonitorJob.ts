import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterTrendsService } from '../trends/TwitterTrendsService';

export class KeywordMonitorJob {
    private job: CronJob;
    private readonly KEYWORDS = ['"ERC-8004" OR "ERC8004" min_faves:2'];

    constructor(
        private storage: PostgresStorage,
        private telegram: ScandexBot,
        private twitterService: TwitterTrendsService
    ) {
        // Run every 15 minutes to save rate limits
        this.job = new CronJob('*/15 * * * *', async () => {
            await this.run();
        });
    }

    start() {
        logger.info('[KeywordMonitor] Job started (15m interval). watching: ERC-8004');
        this.job.start();
        this.run(); // Initial run
    }

    private async run() {
        try {
            logger.info('[KeywordMonitor] Scanning for keywords...');

            for (const query of this.KEYWORDS) {
                // Use existing Twitter service to search
                const tweets = await this.twitterService.searchRecentTweets(query, 5); // Fetch top 5 recent

                for (const tweet of tweets) {
                    const isProcessed = await this.storage.hasSeenKeywordTweet(tweet.tweetId);
                    if (isProcessed) continue;

                    logger.info(`[KeywordMonitor] New hit for ${query}: ${tweet.tweetId}`);

                    // Alert directly (Raw Data)
                    const msg = `🚨 **YENİ TREND ALARMI: ERC-8004**\n\n` +
                        `🐦 **Tweet:** [Link](https://x.com/i/web/status/${tweet.tweetId})\n` +
                        `📝 **İçerik:** ${tweet.text}\n\n` +
                        `⚠️ *Bu bir ham veri bildirisidir, DYOR.*`;

                    await this.telegram.notifyAdmin(msg);

                    // Mark as processed
                    await this.storage.saveKeywordTweet(tweet.tweetId, 'ERC-8004', tweet.text);
                }
            }

        } catch (error) {
            logger.error('[KeywordMonitor] Error running job:', error);
        }
    }
}
