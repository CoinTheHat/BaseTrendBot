import puppeteer from 'puppeteer';
import { logger } from '../utils/Logger';
import { config } from '../config/env';

export class TwitterScraper {
    private browser: any = null;

    async fetchTokenTweets(queries: string[]): Promise<string[]> {
        if (!config.ENABLE_TWITTER_SCRAPING) {
            return [];
        }

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
                    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

                    // Wait for tweets to load
                    await page.waitForSelector('article', { timeout: 5000 }).catch(() => null);

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
