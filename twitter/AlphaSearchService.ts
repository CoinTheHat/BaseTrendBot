import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logger } from '../utils/Logger';
import { config } from '../config/env';

puppeteer.use(StealthPlugin());

export interface AlphaSearchResult {
    velocity: number; // Tweets in last 10 mins
    uniqueAuthors: number; // Unique users
    tweets: string[];
    isEarlyAlpha: boolean;
    isSuperAlpha: boolean;
}

export class AlphaSearchService {
    private browser: any = null;

    /**
     * Checks if a token has "Early Alpha" momentum on Twitter.
     * Logic: Search Cashtag -> Filter Live -> Count tweets in last 10 mins.
     */
    async checkAlpha(symbol: string): Promise<AlphaSearchResult> {
        if (!config.ENABLE_TWITTER_SCRAPING) {
            return { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
        }

        const cashtag = `$${symbol.toUpperCase()}`;
        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(cashtag)}&f=live`;
        let velocity = 0;
        let uniqueAuthors = 0;
        let recentTweetTexts: string[] = [];

        try {
            // Random delay 2-5s to be safe
            const delay = Math.floor(Math.random() * 3000) + 2000;
            await new Promise(r => setTimeout(r, delay));

            if (!this.browser) {
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
            }

            const page = await this.browser.newPage();
            // Randomize User Agent slightly
            const uas = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
            ];
            await page.setUserAgent(uas[Math.floor(Math.random() * uas.length)]);

            logger.info(`[AlphaHunter] Scanning ${cashtag} on Twitter...`);
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });

            // Wait for articles
            try {
                await page.waitForSelector('article', { timeout: 6000 });
            } catch (e) {
                logger.warn(`[AlphaHunter] No tweets found for ${cashtag}`);
                await page.close();
                return { velocity: 0, uniqueAuthors: 0, tweets: [], isEarlyAlpha: false, isSuperAlpha: false };
            }

            // Extract Data
            const tweetData = await page.evaluate(() => {
                const now = Date.now();
                const minutes10 = 10 * 60 * 1000;

                const articles = Array.from(document.querySelectorAll('article'));

                return articles.map(article => {
                    const timeEl = article.querySelector('time');
                    const textEl = article.querySelector('div[data-testid="tweetText"]');
                    const userEl = article.querySelector('div[data-testid="User-Name"] a');

                    if (!timeEl || !textEl) return null;

                    const timeStr = timeEl.getAttribute('datetime');
                    const text = textEl.textContent || "";
                    const handle = userEl ? userEl.getAttribute('href') : "unknown";

                    if (!timeStr) return null;

                    const timeVal = new Date(timeStr).getTime();
                    return {
                        time: timeVal,
                        text: text,
                        handle: handle,
                        isRecent: (now - timeVal) < minutes10
                    };
                }).filter(t => t !== null);
            });

            // Process Results
            // @ts-ignore
            const recentTweets = tweetData.filter(t => t.isRecent);
            velocity = recentTweets.length;

            // Unique Authors
            // @ts-ignore
            const authors = new Set(recentTweets.map(t => t.handle));
            uniqueAuthors = authors.size;

            // @ts-ignore
            recentTweetTexts = recentTweets.map(t => t.text);

            await page.close();

        } catch (err) {
            logger.error(`[AlphaHunter] Error scanning ${cashtag}: ${err}`);
            if (this.browser) {
                await this.browser.close().catch(() => { });
                this.browser = null; // Force restart next time
            }
        }

        // Logic Revisions:
        // Early Alpha: >5 Unique Authors
        // Super Alpha: >15 Unique Authors (High Momentum)
        const isEarlyAlpha = uniqueAuthors >= 5;
        const isSuperAlpha = uniqueAuthors >= 15;

        logger.info(`[AlphaHunter] ${cashtag} Velocity: ${velocity}/10min (Unique: ${uniqueAuthors}). Alpha: ${isEarlyAlpha}`);

        return {
            velocity,
            uniqueAuthors,
            tweets: recentTweetTexts,
            isEarlyAlpha,
            isSuperAlpha
        };
    }
}
