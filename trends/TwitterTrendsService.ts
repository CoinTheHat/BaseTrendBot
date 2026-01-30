import { TwitterApi } from 'twitter-api-v2';
import { config } from '../config/env';
import { TrendItem } from '../models/types';
import { logger } from '../utils/Logger';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export class TwitterTrendsService {
    private client: TwitterApi | null = null;
    private appClient: TwitterApi | null = null;

    constructor() {
        if (config.TWITTER_API_KEY && config.TWITTER_API_SECRET) {
            this.client = new TwitterApi({
                appKey: config.TWITTER_API_KEY,
                appSecret: config.TWITTER_API_SECRET,
                accessToken: config.TWITTER_ACCESS_TOKEN,
                accessSecret: config.TWITTER_ACCESS_SECRET,
            });

            if (config.TWITTER_BEARER_TOKEN) {
                this.appClient = new TwitterApi(config.TWITTER_BEARER_TOKEN);
            }
        }
    }

    async fetchTrends(): Promise<TrendItem[]> {
        logger.info('[Trends] Fetching REAL data from aggregator (Trends24)...');
        return this.scrapeTrends24();
    }

    private async scrapeTrends24(): Promise<TrendItem[]> {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Use env if set (Railway)
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            });
            const page = await browser.newPage();
            // Stealth plugin already active via puppeteer-extra
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

            // Scrape US trends as proxy for Western Crypto Twitter discourse
            // Increased timeout and wait condition
            await page.goto('https://trends24.in/united-states/', { waitUntil: 'domcontentloaded', timeout: 60000 });

            const pageTitle = await page.title();
            logger.info(`[Trends] Page loaded. Title: "${pageTitle}"`);

            if (pageTitle.includes('Cloudflare') || pageTitle.includes('Just a moment') || pageTitle.includes('Access Denied')) {
                logger.error('[Trends] Scraping blocked by Cloudflare/Anti-bot.');
                await page.screenshot({ path: 'trends_block.png', fullPage: true });
                throw new Error('Blocked by Anti-bot protection');
            }

            // Wait for the list to appear
            try {
                await page.waitForSelector('.trend-card__list', { timeout: 5000 });
            } catch (e) {
                logger.warn('[Trends] Selector timeout, page might have changed layout.');
            }

            const trends = await page.evaluate(() => {
                // Selector strategy: Try multiple potential selectors in case of changes
                const selectors = [
                    '.trend-card:nth-child(1) .trend-card__list li', // Recommended Specific
                    '.trend-card:first-child .trend-card__list li',
                    '#trend-list .trend-card__list li',
                    '.trend-card__list li'
                ];

                let listItems = null;
                for (const sel of selectors) {
                    const found = document.querySelectorAll(sel);
                    if (found && found.length > 0) {
                        listItems = found;
                        break;
                    }
                }

                if (!listItems) return [];

                return Array.from(listItems).map(li => {
                    const link = li.querySelector('a');
                    const countSpan = li.querySelector('.trend-card__list--count');

                    const phrase = link?.textContent || '';
                    const countText = countSpan?.textContent || '';

                    let count = 0;
                    if (countText.includes('K')) count = parseFloat(countText) * 1000;
                    else if (countText.includes('M')) count = parseFloat(countText) * 1000000;
                    else count = parseInt(countText) || 0;

                    return { phrase, count };
                });
            });

            if (!trends || trends.length === 0) {
                logger.warn('[Trends] Scraped 0 items. Using fallback.');
                return this.getFallbackTrends();
            }

            // CRYPTO FILTER: Only keep trends relevant to crypto/memecoins
            const cryptoKeywords = ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'doge', 'pepe', 'shib', 'meme', 'coin', 'token', 'nft', 'defi', 'web3', 'blockchain', 'pump', 'moon', 'ape', 'rugpull', 'airdrop', 'whale', 'binance', 'coinbase'];

            const filteredTrends = trends.filter((t: { phrase: string, count: number }) => {
                const lowerPhrase = t.phrase.toLowerCase();
                // Check if trend contains crypto-related keywords
                return cryptoKeywords.some(keyword => lowerPhrase.includes(keyword)) ||
                    lowerPhrase.startsWith('$'); // Include cashtags
            });

            if (filteredTrends.length === 0) {
                logger.warn('[Trends] No crypto-relevant trends found after filtering. Using fallback.');
                return this.getFallbackTrends();
            }

            logger.info(`[Trends] Filtered ${trends.length} → ${filteredTrends.length} crypto-relevant trends.`);

            return filteredTrends.slice(0, 15).map((t: { phrase: string, count: number }, idx: number) => ({
                id: `trend_${Date.now()}_${idx}`,
                phrase: t.phrase,
                source: ['twitter'],
                metrics: { twitterTweets: t.count },
                trendScore: t.count > 50000 ? 90 : t.count > 10000 ? 70 : 50,
                lastUpdated: new Date()
            }));

        } catch (err) {
            logger.error(`[Trends] Scraping failed: ${err}`);
            return this.getFallbackTrends();
        } finally {
            if (browser) await browser.close();
        }
    }

    private getFallbackTrends(): TrendItem[] {
        // Emergency fallbacks if scraping fails (e.g. Layout change, Headless block)
        logger.info('[Trends] Using FALLBACK trend list.');
        return [
            { id: 'fb_1', phrase: 'Solana', source: ['fallback'], metrics: { twitterTweets: 100000 }, trendScore: 90, lastUpdated: new Date() },
            { id: 'fb_2', phrase: 'Bitcoin', source: ['fallback'], metrics: { twitterTweets: 500000 }, trendScore: 85, lastUpdated: new Date() },
            { id: 'fb_3', phrase: 'AI', source: ['fallback'], metrics: { twitterTweets: 200000 }, trendScore: 80, lastUpdated: new Date() },
            { id: 'fb_4', phrase: 'Meme', source: ['fallback'], metrics: { twitterTweets: 50000 }, trendScore: 70, lastUpdated: new Date() },
            { id: 'fb_5', phrase: 'Crypto', source: ['fallback'], metrics: { twitterTweets: 150000 }, trendScore: 75, lastUpdated: new Date() }
        ];
    }
    async searchRecentTweets(query: string, maxResults: number = 10): Promise<{ tweetId: string; text: string; metrics?: any }[]> {
        if (!this.client && !this.appClient) {
            logger.warn('[Twitter] No API client available for search.');
            return [];
        }

        try {
            const clientToUse = this.appClient || this.client;
            // Use v2 search
            const result = await clientToUse!.v2.search(query, {
                'tweet.fields': ['created_at', 'public_metrics', 'id', 'text'],
                max_results: Math.min(maxResults, 100), // API limit check
                sort_order: 'recency'
            });

            const tweets = result.tweets;
            logger.info(`[Twitter] Search "${query}" found ${tweets.length} tweets.`);

            return tweets.map(t => ({
                tweetId: t.id,
                text: t.text,
                metrics: t.public_metrics
            }));

        } catch (error: any) {
            logger.error(`[Twitter] Search failed for "${query}": ${error.message}`);
            return [];
        }
    }
}
