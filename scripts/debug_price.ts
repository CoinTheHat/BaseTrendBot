import 'dotenv/config';
import { BirdeyeService } from '../services/BirdeyeService';
import { logger } from '../utils/Logger';

const birdeye = new BirdeyeService();

import { PostgresStorage } from '../storage/PostgresStorage';

const storage = new PostgresStorage();

async function main() {
    await storage.connect();
    // GoyAI
    const mint = "Cce9MqAGnR996GchYrgcqe6NZYRxfbKTYg5vmDKwpump";
    const solMint = "So11111111111111111111111111111111111111112";

    const tokens = await storage.getAllPerformanceTokens();
    const row = tokens.find(t => t.mint === mint);

    if (!row) {
        console.log("Token not found in DB");
        return;
    }
    const alertTime = new Date(row.alertTimestamp).getTime();
    console.log(`Alert Time: ${new Date(alertTime).toISOString()} (${alertTime})`);

    const targetTime = alertTime + (30 * 60 * 1000);
    const targetUnix = Math.floor(targetTime / 1000);
    console.log(`Target Time (+30m): ${new Date(targetTime).toISOString()} (Unix: ${targetUnix})`);

    const price = await birdeye.getHistoricalPriceUnix(mint, targetUnix);
    console.log(`❌ Price Result: ${price}`);

    // Try a few fallback offsets?
    console.log(`Testing Entry Price at ${Math.floor(alertTime / 1000)}...`);
    const entryPrice = await birdeye.getHistoricalPriceUnix(mint, Math.floor(alertTime / 1000));
    console.log(`Entry Price Result: ${entryPrice}`);

    console.log(`Testing Target (SOL) at ${targetUnix}...`);
    const solPrice = await birdeye.getHistoricalPriceUnix(solMint, targetUnix);
    console.log(`✅ SOL Price Result: ${solPrice}`);

    process.exit(0);
}

main();
