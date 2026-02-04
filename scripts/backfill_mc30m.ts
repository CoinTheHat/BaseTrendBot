import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { AutopsyService } from '../services/AutopsyService';
import { logger } from '../utils/Logger';

const storage = new PostgresStorage();
const birdeye = new BirdeyeService();
const autopsy = new AutopsyService(birdeye);

async function main() {
    logger.info("🚀 Starting Global 30m MC Backfill...");
    await storage.connect();

    const tokens = await storage.getAllPerformanceTokens();
    logger.info(`📋 Found ${tokens.length} tokens to analyze.`);

    let successCount = 0;
    let failCount = 0;

    for (const token of tokens) {
        try {
            // Check if alert timestamp is valid
            if (!token.alertTimestamp) {
                logger.warn(`⚠️ No alert timestamp for ${token.symbol}`);
                continue;
            }

            const entryTime = new Date(token.alertTimestamp).getTime();
            // Skip if token is younger than 30 mins
            if (Date.now() - entryTime < 35 * 60 * 1000) {
                logger.info(`⏭️ Skipping ${token.symbol} (Too fresh, <35m old)`);
                continue;
            }

            // Target: Entry + 30 mins
            const targetTime = entryTime + (30 * 60 * 1000);

            logger.info(`🔍 Analyzing ${token.symbol} (${token.mint}) @ +30m mark...`);

            // 1. Get Price at +30m
            const price30m = await autopsy.getPriceAtTime(token.mint, targetTime);

            if (price30m <= 0) {
                logger.warn(`⚠️ No 30m price data found for ${token.symbol}`);
                failCount++;
                continue;
            }

            // 2. Calculate Market Cap
            let mc30m = 0;
            const entryPrice = token.entryPrice || 0;
            const alertMc = token.alertMc || 0;

            if (entryPrice > 0 && alertMc > 0) {
                // Method A: Proportional
                const multiplier = price30m / entryPrice;
                mc30m = alertMc * multiplier;
                logger.info(`   💡 Calc: $${price30m} / $${entryPrice} = ${multiplier.toFixed(2)}x -> MC@30m: $${Math.floor(mc30m)}`);
            } else {
                // Method B: Supply Fallback
                const over = await birdeye.getTokenOverview(token.mint);
                if (over && over.supply) {
                    mc30m = price30m * over.supply;
                }
            }

            // 3. Update Database
            if (mc30m > 0) {
                await storage.updateMc30m(token.mint, mc30m);
                logger.info(`✅ Updated ${token.symbol}: MC@30m Set to $${Math.floor(mc30m)}`);
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
