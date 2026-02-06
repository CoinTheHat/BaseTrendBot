import axios from 'axios';

async function checkDexScreener() {
    try {
        // Fetch a known Solana pair (e.g., SOL/USDC or a random popular one from search)
        // Let's search for "solana" to get list of pairs
        const searchUrl = 'https://api.dexscreener.com/latest/dex/search?q=solana';
        console.log('Fetching:', searchUrl);
        const response = await axios.get(searchUrl);

        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            const pair = response.data.pairs[0];
            console.log('Keys in pair object:', Object.keys(pair));
            console.log('Full pair object:', JSON.stringify(pair, null, 2));
        } else {
            console.log('No pairs found.');
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

checkDexScreener();
