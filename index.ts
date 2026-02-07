import { config } from './config/env';
import { TokenScanJob } from './jobs/TokenScanJob';
import { GoPlusService } from './services/GoPlusService';
import { DexScreenerService } from './services/DexScreenerService';
import { DashboardServer } from './web/DashboardServer';
import { CooldownManager } from './core/CooldownManager';
import { NarrativeEngine } from './narrative/NarrativeEngine';
import { ScandexBot } from './telegram/TelegramBot';
import { TwitterPublisher } from './twitter/TwitterPublisher';
import { PostgresStorage } from './storage/PostgresStorage';
import { AlphaSearchService } from './twitter/AlphaSearchService';
import { LLMService } from './services/LLMService';
import { logger } from './utils/Logger';
import { twitterAccountManager } from './twitter/TwitterAccountManager';

// Error handling
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err}`);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

async function main() {
    logger.info('🛰️ SCANDEX: GEM HUNTER V3.0 Initializing...');

    // Unlock accounts on boot
    twitterAccountManager.resetAllLocks();

    // 1. Storage & State
    const storage = new PostgresStorage();
    await storage.connect();

    // 2. Services
    const dexScreener = new DexScreenerService();
    const alphaSearchService = new AlphaSearchService();
    const goPlusService = new GoPlusService();
    const llmService = new LLMService();
    const narrative = new NarrativeEngine(llmService);
    const cooldown = new CooldownManager(storage);

    // 3. Alerting & Bot
    const bot = new ScandexBot(dexScreener);
    const twitter = new TwitterPublisher();

    // 4. Main Job (Gem Hunter V3)
    const job = new TokenScanJob(
        dexScreener,
        cooldown,
        narrative,
        bot,
        twitter,
        storage,
        alphaSearchService,
        llmService,
        goPlusService
    );

    // 5. Dashboard
    const dashboard = new DashboardServer(storage);
    dashboard.start();

    // 6. Start
    job.start();

    await bot.notifyAdmin("🚀 **GEM HUNTER V3.0 (BASE)**\nSistem Başlatıldı:\n- Phase 1: Hard Filters & Maturation 🟢\n- Phase 2: Technical Scoring 🟢\n- Phase 3: AI Social Scoring 🟢\n- Phase 4: Final Scorer & Notifications 🟢");

    logger.info('✅ Gem Hunter V3.0 Operational.');

    // Graceful Shutdown
    const shutdown = async () => {
        logger.info('🛑 Shutting down...');
        await bot.stop();
        process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

main();
