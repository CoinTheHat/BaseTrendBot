import { logger } from '../utils/Logger';
import { config } from '../config/env';
import { BirdService } from './BirdService';
import { twitterAccountManager } from './TwitterAccountManager';

export class TwitterScraper {
    private browser: any = null;
    private bird: BirdService;
    private birdLimit = 30;

    constructor() {
        this.bird = new BirdService();
    }

    async fetchTokenTweets(token: { symbol: string; name: string; mint: string }): Promise<string[]> {
        if (!config.ENABLE_TWITTER_SCRAPING) {
            return [];
        }

        // --- SAFE ROUND-ROBIN SCAN (Single Account + Retry) ---
        if (config.TWITTER_AUTH_TOKEN) {
            const allTexts: Set<string> = new Set();
            let attempts = 0;
            const maxAttempts = 2; // 1 Main + 1 Retry

            while (attempts < maxAttempts) {
                attempts++;

                // 1. Pick ONE Account
                const account = twitterAccountManager.getAvailableAccount();

                if (!account) {
                    if (attempts === 1) logger.warn('[Scraper] No accounts available. Skipping.');
                    break;
                }

                try {
                    // logger.info(`[Scraper] Attempt ${attempts}: Using Account #${account.index + 1} for ${queries[0].substring(0, 15)}...`);

                    // 2. Fetch using Fallback Strategy
                    // Note: searchWithFallback handles retries across different query tiers.
                    try {
                        const results = await this.bird.searchWithFallback(token, this.birdLimit);
                        results.forEach(t => allTexts.add(t.text));
                    } catch (e) {
                        logger.warn(`[Scraper] SearchWithFallback failed for ${token.symbol}: ${e}`);
                    }

                } finally {
                    // 3. Release Immediately
                    twitterAccountManager.releaseAccount(account.index, false);
                }

                // 4. Success Check
                if (allTexts.size > 0) {
                    logger.info(`[Scraper] Success on Attempt ${attempts}. Fetched ${allTexts.size} tweets.`);
                    break; // Done, we got data
                } else {
                    if (attempts < maxAttempts) {
                        logger.warn(`[Scraper] 👻 Ghost Protocol: Attempt ${attempts} returned 0 tweets. Retrying with backup account...`);
                    } else {
                        logger.warn(`[Scraper] ❌ NO_SOCIAL_DATA_FOUND: Failed after ${maxAttempts} attempts.`);
                    }
                }
            }

            // 5. Spam Filter (Heuristic)
            const cleanTweets = this.filterSpamTweets(Array.from(allTexts));
            logger.info(`[Scraper] 🧹 Filtered ${allTexts.size - cleanTweets.length} spam tweets. Serving ${cleanTweets.length} clean tweets.`);

            return cleanTweets;
        }

        return [];
    }

    private filterSpamTweets(tweets: string[]): string[] {
        const SPAM_KEYWORDS = [
            'airdrop', 'giveaway', 'whitelist', 'presale', 'join tg', 'dm for promo',
            'free mint', 'send dm', 'promotion', 'collaborate'
        ];

        return tweets.filter(text => {
            const lower = text.toLowerCase();
            // Keep if NO spam keywords are found
            return !SPAM_KEYWORDS.some(keyword => lower.includes(keyword));
        });
    }
}
