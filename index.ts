import { config } from './config/env';
import { TokenScanJob } from './jobs/TokenScanJob';
import { PumpFunService } from './services/PumpFunService';
import { DexScreenerService } from './services/DexScreenerService';
import { BirdeyeService } from './services/BirdeyeService';
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
import { logger } from './utils/Logger';

// Error handling
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err}`);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

async function main() {
    logger.info('🛸 SCANDEX V1 Initializing...');

    // 1. Storage & State
    const storage = new PostgresStorage();
    await storage.connect(); // Connect DB

    // MemeWatchlist now loads from storage internally
    const watchlist = new MemeWatchlist(storage);
    await watchlist.init(); // Load cache

    // 2. Services
    const pumpFun = new PumpFunService();
    const dexScreener = new DexScreenerService();
    const birdeye = new BirdeyeService();
    const twitterService = new TwitterTrendsService();

    // 3. Core & Trends
    const trendCollector = new TrendCollector(twitterService, storage); // Injected
    await trendCollector.init(); // Load trends

    const trendMatcher = new TrendTokenMatcher(new ScoringEngine());
    const matcher = new Matcher(watchlist);
    const scorer = new ScoringEngine();
    const phaseDetector = new PhaseDetector();
    const cooldown = new CooldownManager(storage);

    // 4. Alerting
    const narrative = new NarrativeEngine();
    const bot = new ScandexBot(watchlist, trendCollector, trendMatcher, dexScreener);
    const twitter = new TwitterPublisher();

    // 5. Job
    const job = new TokenScanJob(
        pumpFun,
        dexScreener,
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
        trendMatcher
    );

    // Start
    job.start();
    logger.info('✅ SCANDEX Systems Operational. Watching chains...');
}

main();
