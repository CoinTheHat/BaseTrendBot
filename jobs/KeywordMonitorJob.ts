import { CronJob } from 'cron';
import { logger } from '../utils/Logger';
import { PostgresStorage } from '../storage/PostgresStorage';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterTrendsService } from '../trends/TwitterTrendsService';
import { LLMService } from '../services/LLMService';

export class KeywordMonitorJob {
    private job: CronJob;
    private readonly ALPHA_ACCOUNTS = ['8004_scan', '8004tokens', 'scattering_io', 'DavideCrapis'];
    // Updated Query: Filter retweets, replies, airdrops, enforce min likes
    private readonly QUERY_KEYWORDS = '("ERC-8004" OR "ERC8004" OR "Hybrid Token") -is:retweet -is:reply -airdrop -giveaway min_faves:5';

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
        logger.info('[KeywordMonitor] Job started (Jeweler Mode). Watching: Keywords & Alpha Accounts');
        this.job.start();
        this.run(); // Initial run
    }

    private async run() {
        try {
            logger.info('[KeywordMonitor] Harvesting tweets (Keywords + Alpha Accounts)...');

            // 1. HARVESTING
            // A. Keywords
            const tweetsKeywords = await this.twitterService.searchRecentTweets(this.QUERY_KEYWORDS, 60);

            // B. Alpha Accounts
            const alphaQuery = `(${this.ALPHA_ACCOUNTS.map(u => `from:${u}`).join(' OR ')}) -is:retweet -is:reply`;
            const tweetsAlpha = await this.twitterService.searchRecentTweets(alphaQuery, 40);

            // Merge
            const allTweets = [...tweetsKeywords, ...tweetsAlpha];
            if (allTweets.length === 0) return;

            // 2. PRE-FILTERING (The Sieve)
            const uniqueTweets = new Map<string, any>();

            for (const t of allTweets) {
                // Dup check
                if (uniqueTweets.has(t.text)) continue;

                // Content Check: Must have Cashtag OR CA
                // (High engagement check handled by API query for keywords. Alphas are trusted by author.)
                const hasCashtag = /\$[a-zA-Z]{2,}/.test(t.text);
                const hasCA = /0x[a-fA-F0-9]{40}/.test(t.text);

                // Alpha Bypass: If tweet is from an Alpha Account, accept even without cashtag/CA (might be subtle hint)
                const isAlpha = t.authorUsername && this.ALPHA_ACCOUNTS.some(a => a.toLowerCase() === t.authorUsername?.toLowerCase());

                if (hasCashtag || hasCA || isAlpha) {
                    uniqueTweets.set(t.text, {
                        id: t.tweetId,
                        text: t.text,
                        author: t.authorUsername // Pass username to AI
                    });
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
                // Fallback if source_id missing
                const sourceId = gem.source_id || candidates[0].id;

                // Find original candidate to check author
                const original = candidates.find(c => c.id === sourceId);
                const isAlphaSource = original?.author && this.ALPHA_ACCOUNTS.some(a => a.toLowerCase() === original.author?.toLowerCase());

                // Check dup
                const isProcessed = await this.storage.hasSeenKeywordTweet(sourceId);
                if (isProcessed) continue;

                let title = `💎 **AI KUYUMCUSU: ERC-8004 FIRSATI**`;
                if (isAlphaSource) title = `👑 **ALPHA ALARMI: @${original?.author}**`;

                const msg = `${title}\n\n` +
                    `🔹 **Token:** ${gem.symbol}\n` +
                    `🧠 **Grok Puanı:** ${gem.sentiment}/10 ${isAlphaSource ? '🔥' : ''}\n` +
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
