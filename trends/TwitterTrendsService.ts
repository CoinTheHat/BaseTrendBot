import { TwitterApi } from 'twitter-api-v2';
import { config } from '../config/env';
import { TrendItem } from '../models/types';
import { logger } from '../utils/Logger';
import puppeteer from 'puppeteer';

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
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36');

            // Scrape US trends as proxy for Western Crypto Twitter discourse
            await page.goto('https://trends24.in/united-states/', { waitUntil: 'domcontentloaded', timeout: 30000 });

            const trends = await page.evaluate(() => {
                const listItems = document.querySelectorAll('.trend-card:first-child .trend-card__list li');
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

            return trends.slice(0, 15).map((t: { phrase: string, count: number }, idx: number) => ({
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
}
