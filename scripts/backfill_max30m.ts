import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { AutopsyService } from '../services/AutopsyService';
import { logger } from '../utils/Logger';

const storage = new PostgresStorage();
const birdeye = new BirdeyeService();
const autopsy = new AutopsyService(birdeye);

async function main() {
    logger.info("🚀 Starting Global Max 30m Backfill...");
    await storage.connect();

    const tokens = await storage.getAllPerformanceTokens();
    logger.info(`📋 Found ${tokens.length} tokens to analyze.`);

    let successCount = 0;
    let failCount = 0;

    for (const token of tokens) {
        try {
            if (!token.alertTimestamp) continue;

            const entryTime = new Date(token.alertTimestamp).getTime();
            if (Date.now() - entryTime < 35 * 60 * 1000) {
                logger.info(`⏭️ Skipping ${token.symbol} (Too fresh)`);
                continue;
            }

            logger.info(`🔍 Analzying ${token.symbol}: Finding High in first 30m...`);

            // 1. Get High Price within 30m
            const maxPrice30m = await autopsy.getHigh30m(token.mint, entryTime);

            if (maxPrice30m <= 0) {
                logger.warn(`⚠️ No 30m High data for ${token.symbol}`);
                failCount++;
                continue;
            }

            // 2. Calculate Market Cap
            let maxMc30m = 0;
            const entryPrice = token.entryPrice || 0;
            const alertMc = token.alertMc || 0;

            if (entryPrice > 0 && alertMc > 0) {
                const multiplier = maxPrice30m / entryPrice;
                maxMc30m = alertMc * multiplier;
                logger.info(`   💡 High Calc: $${maxPrice30m} / $${entryPrice} = ${multiplier.toFixed(2)}x -> MaxMC@30m: $${Math.floor(maxMc30m)}`);
            } else {
                const over = await birdeye.getTokenOverview(token.mint);
                if (over && over.supply) {
                    maxMc30m = maxPrice30m * over.supply;
                }
            }

            // 3. Update Database
            if (maxMc30m > 0) {
                await storage.updateHybrid30m(token.mint, maxMc30m);
                successCount++;
            } else {
                failCount++;
            }

            // Rate Limit Guard
            await new Promise(r => setTimeout(r, 200));

        } catch (err) {
            logger.error(`❌ Failed ${token.symbol}: ${err}`);
            failCount++;
        }
    }

    logger.info(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏁 Backfill Complete
✅ Success: ${successCount}
❌ Failed: ${failCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
