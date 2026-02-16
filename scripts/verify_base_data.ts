
import { DexScreenerService } from '../services/DexScreenerService';
import { logger } from '../utils/Logger';

async function verifyBaseData() {
    const dex = new DexScreenerService();

    logger.info("SEARCHING for a Base token (BRETT)...");
    const searchResults = await dex.search("BRETT");
    const basePair = searchResults.find(p => p.pairAddress && p.mint.startsWith("0x"));

    if (!basePair || !basePair.pairAddress) {
        logger.error("Could not find a valid Base pair for testing.");
        return;
    }

    logger.info(`FOUND Pair: ${basePair.symbol} (${basePair.pairAddress})`);

    logger.info("FETCHING Internal Details...");
    const details = await dex.getPairDetails(basePair.pairAddress);

    if (details) {
        logger.info("✅ DATA RECEIVED:");
        logger.info(`Holders: ${details.holderCount}`);
        logger.info(`Top 10%: ${details.top10Percent.toFixed(2)}%`);
        logger.info(`Liquidity Locked: ${details.liquidity.totalLockedPercent}%`);
        logger.info(`Is Mintable: ${details.security.isMintable}`);
        logger.info(`Is Freezable: ${details.security.isFreezable}`);
    } else {
        logger.error("❌ FAILED to scrape details.");
    }

    process.exit(0);
}

verifyBaseData();
