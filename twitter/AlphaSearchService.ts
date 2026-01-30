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
        // Emergency: Simplified Query to reduce timeouts
        const query = `${cashtag}`;
        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;
        let velocity = 0;
        let uniqueAuthors = 0;
        let tweets: string[] = [];

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

            // Fix: Check closed state wrapper
            if (page.isClosed()) {
                logger.warn('[AlphaHunter] Page closed unexpectedly, recreating...');
            }

            // Randomize User Agent (Mobile favored)
            const uas = [
                'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
            ];
            await page.setUserAgent(uas[Math.floor(Math.random() * uas.length)]);

            // Fix: Wait Condition - 2s timeout for fast fail-over
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 2000 });

            // Fix: Selector Check - 2s timeout
            try {
                await page.waitForSelector('article', { timeout: 2000 });
            } catch (e) {
                logger.warn(`[AlphaHunter] No tweets found for ${cashtag} (Timeout)`);
            }

            // Extract Data
            const tweetData: any[] = await page.evaluate(() => {
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
            const recentTweets = tweetData.filter((t: any) => t.isRecent);
            velocity = recentTweets.length;

            // Unique Authors
            const authors = new Set(recentTweets.map((t: any) => t.handle));
            uniqueAuthors = authors.size;

            tweets = recentTweets.map((t: any) => t.text);

            await page.close();

        } catch (err: any) {
            const errorMsg = err.message || err.toString();
            console.log(`[AlphaHunter] DEBUG: Error for ${cashtag}: ${errorMsg}`); // Direct console
            logger.error(`[AlphaHunter] Error scanning ${cashtag}: ${errorMsg}. (Status: ${err.response?.status || 'Unknown'})`);
            if (this.browser) {
                await this.browser.close().catch(() => { });
                this.browser = null; // Force restart next time
            }
        }

        // Logic Revisions (Optimized for Early Detection):
        // Early Alpha: >10 Unique Authors (Was 20 - Reduced for faster alerts)
        // Super Alpha: >30 Unique Authors (High Momentum)
        const isEarlyAlpha = uniqueAuthors >= 10;
        const isSuperAlpha = uniqueAuthors >= 30;

        logger.info(`[AlphaHunter] ${cashtag} Velocity: ${velocity}/10min (Unique: ${uniqueAuthors}). Alpha: ${isEarlyAlpha}`);

        return {
            velocity,
            uniqueAuthors,
            tweets,
            isEarlyAlpha,
            isSuperAlpha
        };
    }
}
