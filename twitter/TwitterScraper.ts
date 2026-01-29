import puppeteer from 'puppeteer';
import { logger } from '../utils/Logger';
import { config } from '../config/env';

import { BirdService } from './BirdService';

export class TwitterScraper {
    private browser: any = null;
    private bird: BirdService;

    constructor() {
        this.bird = new BirdService();
    }

    async fetchTokenTweets(queries: string[]): Promise<string[]> {
        if (!config.ENABLE_TWITTER_SCRAPING) {
            return [];
        }

        // Fast Path: Use Bird.Fast if credentials exist
        if (config.TWITTER_AUTH_TOKEN) {
            const allTexts: Set<string> = new Set();
            for (const q of queries) {
                try {
                    const results = await this.bird.search(q, config.TWITTER_SCRAPE_MAX_TWEETS || 10);
                    results.forEach(t => allTexts.add(t.text));
                } catch (e) {
                    logger.warn(`[Scraper] Bird search failed for ${q}: ${e}`);
                }
            }
            return Array.from(allTexts);
        }

        // Fallback: Puppeteer (Legacy)
        const allTweets: Set<string> = new Set();

        try {
            this.browser = await puppeteer.launch({
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

            const page = await this.browser.newPage();
            // Set User Agent to avoid immediate blocking
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36');

            for (const query of queries) {
                if (allTweets.size >= config.TWITTER_SCRAPE_MAX_TWEETS) break;

                const url = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;
                logger.info(`[Scraper] Visiting: ${url}`);

                try {
                    // Optimized navigation
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

                    // Wait for content - Twitter is heavy, give it a moment or look for specific failed states
                    try {
                        await page.waitForSelector('article', { timeout: 7000 });
                    } catch (e) {
                        // Retry once with reload or just log
                        logger.warn(`[Scraper] Timeout waiting for tweets for ${query}, retrying load...`);
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    // Extract text
                    const tweets = await page.evaluate(() => {
                        const articles = document.querySelectorAll('article');
                        return Array.from(articles).map(article => {
                            const textDiv = article.querySelector('div[data-testid="tweetText"]');
                            return textDiv ? textDiv.textContent || '' : '';
                        }).filter(t => t.length > 20); // Filter short garbage
                    });

                    tweets.forEach((t: string) => allTweets.add(t));

                } catch (err) {
                    logger.warn(`[Scraper] Failed query "${query}": ${err}`);
                    // Continue to next query
                }
            }

        } catch (err) {
            logger.error(`[Scraper] Fatal error: ${err}`);
        } finally {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
        }

        return Array.from(allTweets).slice(0, config.TWITTER_SCRAPE_MAX_TWEETS);
    }
}
