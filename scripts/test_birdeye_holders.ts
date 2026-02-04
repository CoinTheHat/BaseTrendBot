import axios from 'axios';

const BIRDEYE_KEY = 'e7724662fb4b49db991cffe5bbac36b3';
const TEST_CA = '5L3QmuE27vrg5vk3nE6fRWfEXEWEZmoh4rH8vm5Upump';

async function testHolderDistribution() {
    console.log(`[Test] Testing Birdeye Hybrid Holder Logic for: ${TEST_CA}`);

    try {
        // --- STRATEGY A: Primary Distribution Endpoint ---
        console.log(`[Test] Trying Primary: /defi/token_holder_distribution with 'token_address'...`);
        try {
            const respA = await axios.get('https://public-api.birdeye.so/defi/token_holder_distribution', {
                headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
                params: { token_address: TEST_CA }
            });

            if (respA.data?.success && respA.data?.data) {
                const data = respA.data.data;
                const items = data.items || [];
                const top10 = items.slice(0, 10).reduce((s: number, h: any) => s + (h.percent_of_supply || 0), 0);
                console.log(`[Success A] Holders: ${data.total}, Top 10%: ${(top10 * 100).toFixed(2)}%`);
                return;
            }
        } catch (errA: any) {
            console.warn(`[Info] Primary Endpoint Failed/404 (${errA.response?.status}). Moving to Hybrid Fallback...`);
        }

        // --- STRATEGY B: Hybrid (v3/token/holder + token_overview) ---
        console.log(`[Test] Trying Fallback: v3/token/holder + token_overview...`);

        // 1. Get Holders List
        const respB1 = await axios.get('https://public-api.birdeye.so/defi/v3/token/holder', {
            headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
            params: { address: TEST_CA, offset: 0, limit: 10 }
        });
        console.log(`[Debug B1] Success: ${respB1.data?.success}, Has Data: ${!!respB1.data?.data}`);

        // 2. Get Supply via Overview
        const respB2 = await axios.get('https://public-api.birdeye.so/defi/token_overview', {
            headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
            params: { address: TEST_CA }
        });
        console.log(`[Debug B2] Success: ${respB2.data?.success}, Has Data: ${!!respB2.data?.data}`);

        if (respB1.data?.data && respB2.data?.data) {
            const holders = respB1.data.data.items || [];
            console.log(`[Debug B1] Sample Holder Item:`, JSON.stringify(holders[0], null, 2));
            const supply = respB2.data.data.supply || 0;
            const totalHolders = respB1.data.data.total || 0;

            if (supply > 0) {
                const top10Raw = holders.slice(0, 10).reduce((s: number, h: any) => s + (Number(h.amount) || 0), 0);
                const top10Percent = top10Raw / supply;
                console.log(`[Success B] Holders: ${totalHolders}, Supply: ${supply}, Top 10%: ${(top10Percent * 100).toFixed(2)}%`);
                return;
            } else {
                console.warn(`[Warn B] Supply is 0 for ${TEST_CA}`);
            }
        }

        console.error(`[Fail] Could not retrieve holder data via any strategy.`);

    } catch (err: any) {
        console.error(`[Error] Request failed: ${err.message}`);
        if (err.response) {
            console.error(`[Error Details] Status: ${err.response.status}`);
            console.error(`[Error Details] Data:`, JSON.stringify(err.response.data));
        }
    }
}

testHolderDistribution();
