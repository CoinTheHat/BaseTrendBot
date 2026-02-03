import { config } from './config/env';
import { TokenScanJob } from './jobs/TokenScanJob';
import { PumpFunService } from './services/PumpFunService';
import { BirdeyeService } from './services/BirdeyeService';
import { GoPlusService } from './services/GoPlusService';
import { PerformanceMonitorJob } from './jobs/PerformanceMonitorJob';
import { AutopsyService } from './services/AutopsyService';
import { DexScreenerService } from './services/DexScreenerService';
// import { KeywordMonitorJob } from './jobs/KeywordMonitorJob'; // Removed
import { DashboardServer } from './web/DashboardServer';
import { Matcher } from './core/Matcher';
import { ScoringEngine } from './core/ScoringEngine';
import { PhaseDetector } from './core/PhaseDetector';
import { CooldownManager } from './core/CooldownManager';
import { NarrativeEngine } from './narrative/NarrativeEngine';
import { ScandexBot } from './telegram/TelegramBot';
import { TwitterPublisher } from './twitter/TwitterPublisher';
import { PostgresStorage } from './storage/PostgresStorage'; // Updated
import { MemeWatchlist } from './core/MemeWatchlist';
import { TwitterTrendsService } from './trends/TwitterTrendsService';
import { TrendCollector } from './trends/TrendCollector';
import { TrendTokenMatcher } from './core/TrendTokenMatcher';
import { AlphaSearchService } from './twitter/AlphaSearchService';
import { LLMService } from './services/LLMService';
import { logger } from './utils/Logger';
import { PortfolioTrackerJob } from './jobs/PortfolioTrackerJob';

// Error handling
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err}`);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

import { twitterAccountManager } from './twitter/TwitterAccountManager';

async function main() {
    logger.info('🛸 SCANDEX V1 Initializing...');

    // Unlock accounts on boot
    twitterAccountManager.resetAllLocks();

    // 1. Storage & State
    const storage = new PostgresStorage();
    await storage.connect(); // Connect DB

    // MemeWatchlist now loads from storage internally
    const watchlist = new MemeWatchlist(storage);
    await watchlist.init(); // Load cache

    // 2. Services
    const pumpFun = new PumpFunService();
    // const birdeye = new BirdeyeService(); // DISABLED
    const dexScreener = new DexScreenerService();
    const twitterService = new TwitterTrendsService();
    const alphaSearchService = new AlphaSearchService(); // Instantiated
    const goPlusService = new GoPlusService();

    // 3. Core & Trends
    const trendCollector = new TrendCollector(twitterService, storage); // Injected
    await trendCollector.init(); // Load trends

    const trendMatcher = new TrendTokenMatcher(new ScoringEngine());
    const matcher = new Matcher(watchlist);
    const scorer = new ScoringEngine();
    const phaseDetector = new PhaseDetector();
    const cooldown = new CooldownManager(storage);

    // 4. Alerting
    const llmService = new LLMService();
    const narrative = new NarrativeEngine(llmService);
    const bot = new ScandexBot(watchlist, trendCollector, trendMatcher);
    const twitter = new TwitterPublisher();

    const birdeye = new BirdeyeService(); // Keep instance for Type compatibility in TokenScanJob for now, but ensure logic doesn't use it.

    // 5. Autopsy Service (New)
    const autopsyService = new AutopsyService(birdeye);

    // 6. Job
    const job = new TokenScanJob(
        pumpFun,
        birdeye,
        dexScreener, // INJECTED: DexScreener for M5 trending
        matcher,
        scorer,
        phaseDetector,
        cooldown,
        narrative,
        bot,
        twitter,
        storage,
        trendCollector,
        trendMatcher,
        alphaSearchService // Injected
    );

    // 7. Performance & Dashboard
    const performanceJob = new PerformanceMonitorJob(storage, dexScreener, bot, autopsyService);
    const portfolioTracker = new PortfolioTrackerJob(storage); // BirdEye Removed
    // REMOVED: KeywordMonitorJob (Jeweler Mode) killed by user request.
    const dashboard = new DashboardServer(storage); // Railway auto-sets PORT env var

    performanceJob.start();
    portfolioTracker.start();
    dashboard.start();

    // Start
    job.start();
    await bot.notifyAdmin("🚀 **TRENDBOT V3 (Premium Sniper)**\nSistem Başlatıldı:\n- Trending V3 Scanner: 🟢\n- Autopsy (Gap Filling): 🟢\n- Portfolio Tracker (30m): 🟢");
    logger.info('✅ TrendBot Systems Operational. Scanning V3 Trending...');

    // Graceful Shutdown
    const shutdown = async () => {
        logger.info('🛑 Shutting down...');
        await bot.stop(); // Stop Telegram Polling
        process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

main();
