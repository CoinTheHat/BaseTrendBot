import axios from 'axios';

async function testRecentTokens() {
    console.log('🔍 Testing DexScreener trending endpoint...\n');

    try {
        // Test trending pairs on Base
        // Using the endpoint that the scraper uses
        const trendingUrl = 'https://api.dexscreener.com/latest/dex/pairs/base/aerodrome?limit=50&order=trendingScoreM5';
        const response = await axios.get(trendingUrl, { timeout: 10000 });

        if (response.data?.pairs?.length > 0) {
            console.log(`Found ${response.data.pairs.length} pairs\n`);

            // Check first pair keys
            const sample = response.data.pairs[0];
            console.log('Sample keys:', Object.keys(sample));
            console.log('Has pairCreatedAt?', 'pairCreatedAt' in sample);

            // Print first 3 pairs
            response.data.pairs.slice(0, 3).forEach((p: any, i: number) => {
                console.log(`\n${i + 1}. ${p.baseToken?.symbol}`);
                console.log('   All keys:', Object.keys(p));
                console.log('   pairCreatedAt:', p.pairCreatedAt);
            });
        } else {
            console.log('No pairs found or error:', response.data);
        }
    } catch (error: any) {
        console.error('Error:', error.message);
    }
}

testRecentTokens();
