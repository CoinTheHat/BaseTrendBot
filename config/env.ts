import dotenv from 'dotenv';
dotenv.config();

export const config = {
    // Telegram
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    TELEGRAM_ADMIN_IDS: (process.env.TELEGRAM_ADMIN_ID || '').split(',').map(id => id.trim()).filter(id => id),

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
    TWITTER_AUTH_TOKEN: process.env.TWITTER_AUTH_TOKEN || '', // Legacy single
    TWITTER_CT0: process.env.TWITTER_CT0 || '', // Legacy single

    // Cookie-Based Auth Pool (New System)
    TWITTER_AUTH_TOKENS: (process.env.TWITTER_AUTH_TOKENS || '').split(',').map(t => t.trim()).filter(t => t),
    TWITTER_CT0S: (process.env.TWITTER_CT0S || '').split(',').map(t => t.trim()).filter(t => t),
    TWITTER_PROXIES: (process.env.TWITTER_PROXIES || '').split(',').map(t => t.trim()).filter(t => t), // NEW: Proxy Support

    // Primary Engine: xAI (Grok)
    XAI_API_KEY: process.env.XAI_API_KEY || process.env.GROK_API_KEY || '',
    XAI_MODEL: 'grok-4-1-fast-non-reasoning',

    // Dashboard Security (Simplified for Access)
    DASHBOARD_USER: process.env.DASHBOARD_USER || 'admin',
    DASHBOARD_PASS: process.env.DASHBOARD_PASS || 'admin123',

    // Trends
    TREND_UPDATE_INTERVAL_MINUTES: Number(process.env.TREND_UPDATE_INTERVAL_MINUTES) || 30,

    // Database
    DATABASE_URL: process.env.DATABASE_URL || '',

    // Scanner Settings
    SCAN_INTERVAL_SECONDS: Number(process.env.SCAN_INTERVAL_SECONDS) || 60,
    ALERT_COOLDOWN_MINUTES: Number(process.env.ALERT_COOLDOWN_MINUTES) || 1, // Reduced to 1m for testing
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
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',

    // Base Chain Monitoring
    BASE_KEYWORDS: ["ERC-8004", "ERC8004", "Hybrid Token", "404"]
};

// Simple validation
const missingKeys: string[] = [];
if (!config.TELEGRAM_BOT_TOKEN) missingKeys.push('TELEGRAM_BOT_TOKEN');
if (!config.TELEGRAM_CHAT_ID) missingKeys.push('TELEGRAM_CHAT_ID');

if (missingKeys.length > 0) {
    console.warn(`[Config] Missing critical env vars: ${missingKeys.join(', ')}`);
}
