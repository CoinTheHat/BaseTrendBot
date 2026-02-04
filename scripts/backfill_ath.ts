import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { AutopsyService } from '../services/AutopsyService';
import { logger } from '../utils/Logger';

const storage = new PostgresStorage();
const birdeye = new BirdeyeService();
const autopsy = new AutopsyService(birdeye);

async function main() {
    logger.info("🚀 Starting Global ATH Backfill...");
    await storage.connect();

    const tokens = await storage.getAllPerformanceTokens();
    logger.info(`📋 Found ${tokens.length} tokens to analyze.`);

    let successCount = 0;
    let failCount = 0;

    for (const token of tokens) {
        try {
            // Skip very fresh tokens (< 10 mins) to avoid noise
            if (Date.now() - new Date(token.alertTimestamp).getTime() < 10 * 60 * 1000) {
                logger.info(`⏭️ Skipping ${token.symbol} (Too fresh)`);
                continue;
            }

            logger.info(`🔍 Analyzing ${token.symbol} (${token.mint})...`);

            // 1. Get True ATH Price (Highest Price seen since Alert)
            // Note: alertTimestamp is Date, calculateTrueAth expects ms number
            const entryTime = new Date(token.alertTimestamp).getTime();
            const trueAthPrice = await autopsy.calculateTrueAth(token.mint, entryTime);

            if (trueAthPrice <= 0) {
                logger.warn(`⚠️ No price data found for ${token.symbol}`);
                failCount++;
                continue;
            }

            // 2. Calculate Market Cap
            let trueAthMc = 0;
            const entryPrice = token.entryPrice || 0;
            const alertMc = token.alertMc || 0;

            if (entryPrice > 0 && alertMc > 0) {
                // Method A: Proportional (Assumes constant supply)
                const multiplier = trueAthPrice / entryPrice;
                trueAthMc = alertMc * multiplier;
                logger.info(`   💡 Calc: $${trueAthPrice} / $${entryPrice} = ${multiplier.toFixed(2)}x -> ATH MC: $${Math.floor(trueAthMc)}`);
            } else {
                // Method B: Live Supply Fallback
                logger.info(`   ⚠️ Missing Entry Data. Fetching Live Overview...`);
                const over = await birdeye.getTokenOverview(token.mint);
                if (over && over.supply) {
                    trueAthMc = trueAthPrice * over.supply;
                } else {
                    logger.warn(`   ❌ Failed to get supply for ${token.symbol}`);
                }
            }

            // 3. Update Database
            if (trueAthMc > 0) {
                await storage.correctATH(token.mint, trueAthMc);
                logger.info(`✅ Updated ${token.symbol}: ATH Set to $${Math.floor(trueAthMc)}`);
                successCount++;
            } else {
                failCount++;
            }

            // Rate Limit Guard (Tiny sleep)
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
