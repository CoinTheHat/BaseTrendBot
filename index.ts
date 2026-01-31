import { config } from './config/env';
import { TokenScanJob } from './jobs/TokenScanJob';
import { PumpFunService } from './services/PumpFunService';
import { BirdeyeService } from './services/BirdeyeService';
import { GoPlusService } from './services/GoPlusService';
import { PerformanceMonitorJob } from './jobs/PerformanceMonitorJob';
import { DexScreenerService } from './services/DexScreenerService';
import { KeywordMonitorJob } from './jobs/KeywordMonitorJob';
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
    const birdeye = new BirdeyeService();
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

    // 5. Job
    const job = new TokenScanJob(
        pumpFun,
        birdeye,
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
        alphaSearchService, // Injected
        goPlusService
    );

    // 6. Performance & Dashboard
    const performanceJob = new PerformanceMonitorJob(storage, birdeye);
    const keywordJob = new KeywordMonitorJob(storage, bot, twitterService, llmService); // New Sniper with AI
    const dashboard = new DashboardServer(storage); // Railway auto-sets PORT env var

    performanceJob.start();
    keywordJob.start();
    dashboard.start();

    // Start
    job.start();
    await bot.notifyAdmin("🚀 **Sistemler Aktif!**\nSCANDEX taramaya başladı.\n_Bu mesajı görüyorsan bot çalışıyor demektir._");
    logger.info('✅ SCANDEX Systems Operational. Watching chains...');
}

main();
