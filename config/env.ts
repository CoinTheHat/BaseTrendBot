import dotenv from 'dotenv';
dotenv.config();

export const config = {
    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    TELEGRAM_ADMIN_ID: process.env.TELEGRAM_ADMIN_ID || '',

    // Twitter
    TWITTER_API_KEY: process.env.TWITTER_API_KEY || '',
    TWITTER_API_SECRET: process.env.TWITTER_API_SECRET || '',
    TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN || '',
    TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET || '',
    TWITTER_BEARER_TOKEN: process.env.TWITTER_BEARER_TOKEN || '',
    ENABLE_TWITTER_ALERTS: process.env.ENABLE_TWITTER_ALERTS === 'true',

    // Scraping (Headless)
    ENABLE_TWITTER_SCRAPING: process.env.ENABLE_TWITTER_SCRAPING === 'true',
    TWITTER_SCRAPE_MAX_TWEETS: Number(process.env.TWITTER_SCRAPE_MAX_TWEETS) || 10,
    TWITTER_AUTH_TOKEN: process.env.TWITTER_AUTH_TOKEN || '',
    TWITTER_CT0: process.env.TWITTER_CT0 || '',

    // AI / LLM
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '', // Kept for fallback
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '', // Google Gemini (Free Tier)
    AI_MODEL: process.env.AI_MODEL || 'gemini-3.0-flash', // Corrected to 3.0 based on user input

    // Trends
    TREND_UPDATE_INTERVAL_MINUTES: Number(process.env.TREND_UPDATE_INTERVAL_MINUTES) || 30,

    // Database
    DATABASE_URL: process.env.DATABASE_URL || '',

    // Scanner Settings
    SCAN_INTERVAL_SECONDS: Number(process.env.SCAN_INTERVAL_SECONDS) || 30,
    ALERT_COOLDOWN_MINUTES: Number(process.env.ALERT_COOLDOWN_MINUTES) || 10,
    MAX_ALERTS_PER_HOUR: Number(process.env.MAX_ALERTS_PER_HOUR) || 12,
    NETWORK: process.env.NETWORK || 'solana',

    // Thresholds
    MIN_MC_USD: Number(process.env.MIN_MC_USD) || 50000,
    MAX_MC_USD: Number(process.env.MAX_MC_USD) || 400000,
    MIN_LIQUIDITY_USD: Number(process.env.MIN_LIQUIDITY_USD) || 5000,
    ALERT_SCORE_THRESHOLD: Number(process.env.ALERT_SCORE_THRESHOLD) || 5,

    // APIs
    PUMPFUN_API_KEY: process.env.PUMPFUN_API_KEY || '', // If needed later
    DEXSCREENER_API_KEY: process.env.DEXSCREENER_API_KEY || '',
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || ''
};

// Simple validation
const missingKeys: string[] = [];
if (!config.TELEGRAM_BOT_TOKEN) missingKeys.push('TELEGRAM_BOT_TOKEN');
if (!config.TELEGRAM_CHAT_ID) missingKeys.push('TELEGRAM_CHAT_ID');

if (missingKeys.length > 0) {
    console.warn(`[Config] Missing critical env vars: ${missingKeys.join(', ')}`);
}
