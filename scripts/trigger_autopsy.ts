
import { config } from '../config/env';
import { PostgresStorage } from '../storage/PostgresStorage';
import { BirdeyeService } from '../services/BirdeyeService';
import { logger } from '../utils/Logger';

// Mock dependencies
const storage = new PostgresStorage();
const birdeye = new BirdeyeService();

async function runAutopsy(mint?: string) {
    logger.info('🔬 Starting Manual Autopsy...');

    let tokensToCheck = [];

    if (mint) {
        // Check single token
        const perf = await storage.getPerformance(mint);
        if (perf) {
            tokensToCheck.push(perf);
        } else {
            // Mock data if not in DB for testing
            logger.warn(`Token ${mint} not found in DB performance table. Using mock values for test.`);
            // EPSIZZA Mock based on user input: Entry MC $64.6k
            tokensToCheck.push({
                mint,
                alertTimestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
                entryPrice: 0.00006, // Hypothetical entry for ratio calc
                alertMc: 64600
            });
        }
    } else {
        // Get failed/mooned/tracking tokens from DB directly (Simulating Job)
        // For test, let's just use a hardcoded known token if none provided, or list recent
        logger.warn('No mint provided. Scanning recent TRACKING tokens...');
        const tracking = await storage.getTrackingTokens();
        tokensToCheck = tracking.slice(0, 1); // Test on 1 result
    }

    if (tokensToCheck.length === 0) {
        logger.error('No tokens found to autopsy.');
        process.exit(0);
    }

    for (const t of tokensToCheck) {
        logger.info(`🔍 Analysing ${t.mint}...`);

        // 1. Get OHLCV (Last 24h)
        const now = Math.floor(Date.now() / 1000);
        const alertTime = Math.floor((t.alertTimestamp?.getTime() || (Date.now() - 86400000)) / 1000);

        // Fetch 15m candles
        const candles = await birdeye.getHistoricalCandles(t.mint, '15m', alertTime, now);

        if (candles.length === 0) {
            logger.warn(`⚠️ No candle data for ${t.mint}`);
            continue;
        }

        // 2. Find True High
        let trueHigh = 0;
        for (const c of candles) {
            if (c.h > trueHigh) trueHigh = c.h;
        }

        logger.info(`📊 BirdEye True High: $${trueHigh}`);

        // 3. Get Token Info for MC Calc
        // Fallback Strategy: Ratio Calculation (Supply agnostic)
        // TrueAthMC = (TrueHighPrice / EntryPrice) * EntryMC

        let trueAthMc = 0;
        let method = 'UNKNOWN';

        if ((t.entryPrice || 0) > 0 && (t.alertMc || 0) > 0) {
            // BEST METHOD: Proportional
            const entryPrice = t.entryPrice || 1; // Safe fallback for TS
            const ratio = trueHigh / entryPrice;
            trueAthMc = (t.alertMc || 0) * ratio;
            method = `RATIO (Ratio: ${ratio.toFixed(2)}x)`;
        } else {
            // FALLBACK: Try BirdEye Supply
            const overview = await birdeye.getTokenOverview(t.mint);
            if (overview && overview.supply > 0) {
                trueAthMc = trueHigh * overview.supply;
                method = 'SUPPLY';
            } else {
                logger.warn(`⚠️ Cannot calc MC: No Entry Price/MC and No Supply data.`);
            }
        }

        if (trueAthMc > 0) {
            logger.info(`🧮 Calculated via ${method}: $${Math.floor(trueAthMc)}`);
            // 4. Update DB
            await storage.correctATH(t.mint, trueAthMc);
            logger.info('✅ ATH Corrected in DB.');
        }

        // 4. Update DB
        if (trueAthMc > 0) {
            await storage.correctATH(t.mint, trueAthMc);
            logger.info('✅ ATH Corrected in DB.');
        }
    }

    logger.info('DONE.');
    process.exit(0);
}

// Get mint from args
const targetMint = process.argv[2];
runAutopsy(targetMint);
