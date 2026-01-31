import { BirdeyeService } from '../services/BirdeyeService';
import { logger } from '../utils/Logger';

/**
 * Diagnostic Script: Analyze BirdEye V3 Data to Understand Filter Impact
 */
async function diagnoseFilters() {
    console.log('🔍 FILTER DIAGNOSTIC STARTED\n');

    const birdeye = new BirdeyeService();

    const tokens = await birdeye.fetchTrendingTokens('solana');

    console.log(`📡 Fetched ${tokens.length} tokens from BirdEye V3\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let passLiq = 0;
    let passVol = 0;
    let passImpulse = 0;
    let passAll = 0;

    for (const token of tokens) {
        const liq = token.liquidityUsd || 0;
        const v5m = token.volume5mUsd || ((token.volume24hUsd || 0) / 100);
        const impulse = v5m / (liq || 1);

        const checkLiq = liq >= 5000;
        const checkVol = v5m >= 5000;
        const checkImpulse = impulse >= 1.5;

        if (checkLiq) passLiq++;
        if (checkVol) passVol++;
        if (checkImpulse) passImpulse++;
        if (checkLiq && checkVol && checkImpulse) passAll++;

        // Show first 10 tokens as examples
        if (tokens.indexOf(token) < 10) {
            console.log(`${token.symbol.padEnd(10)} | Liq: $${Math.floor(liq).toString().padStart(8)} ${checkLiq ? '✅' : '❌'} | Vol: $${Math.floor(v5m).toString().padStart(8)} ${checkVol ? '✅' : '❌'} | Impulse: ${impulse.toFixed(2).padStart(5)}x ${checkImpulse ? '✅' : '❌'}`);
        }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📊 FILTER STATISTICS:\n');
    console.log(`Total Tokens: ${tokens.length}`);
    console.log(`Pass Liq ($5k):      ${passLiq}/${tokens.length} (${((passLiq / tokens.length) * 100).toFixed(1)}%)`);
    console.log(`Pass Vol ($5k):      ${passVol}/${tokens.length} (${((passVol / tokens.length) * 100).toFixed(1)}%)`);
    console.log(`Pass Impulse (1.5x): ${passImpulse}/${tokens.length} (${((passImpulse / tokens.length) * 100).toFixed(1)}%)`);
    console.log(`\n✅ PASS ALL FILTERS:  ${passAll}/${tokens.length} (${((passAll / tokens.length) * 100).toFixed(1)}%)\n`);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (passAll === 0) {
        console.log('⚠️  WARNING: NO TOKENS PASSED ALL FILTERS!');
        console.log('\n💡 RECOMMENDATIONS:');
        console.log('1. Lower 5m Volume threshold from $5k to $3k');
        console.log('2. Lower Impulse ratio from 1.5x to 1.2x');
        console.log('3. Or use 24h volume instead of estimated 5m volume\n');
    }

    process.exit(0);
}

diagnoseFilters().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
