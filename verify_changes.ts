import { DexScreenerService } from './services/DexScreenerService';
import { logger } from './utils/Logger';

async function verify() {
    const ds = new DexScreenerService();

    // Test getLatestPairs to see if pairAddress is populated
    console.log("Fetching latest pairs...");
    const pairs = await ds.getLatestPairs();

    if (pairs.length > 0) {
        const p = pairs[0];
        console.log(`First Pair: ${p.symbol} (${p.mint})`);
        console.log(`Pair Address: ${p.pairAddress}`);

        if (p.pairAddress) {
            console.log("Fetching Details via Internal API...");
            const details = await ds.getPairDetails(p.pairAddress);
            if (details) {
                console.log("Details Retrieved:");
                console.log(`- Holders: ${details.holderCount} (Top10: ${details.top10Percent.toFixed(1)}%)`);
                console.log(`- Security: Mint=${details.security.isMintable}, Freeze=${details.security.isFreezable}`);
                console.log(`- Liquidity: Burned=${details.liquidity.burnedPercent}%`);
            } else {
                console.log("Details: null");
            }
        } else {
            console.error("pairAddress is missing from token snapshot!");
        }
    } else {
        console.log("No pairs found.");
    }
}

verify().catch(console.error);
