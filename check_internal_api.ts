import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

async function checkInternalDexApi() {
    let browser;
    try {
        const pairAddress = 'd2xwxkhuly41ycehappyygs5tyfu6d2t1qswgmvrdcj4';
        console.log(`Testing with Pair Address: ${pairAddress}`);

        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        console.log('Navigating to pair page...');
        try {
            await page.goto(`https://dexscreener.com/solana/${pairAddress}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) { console.log("Navigation timeout (ignore)"); }

        const internalUrl = `https://io.dexscreener.com/dex/pair-details/v4/solana/${pairAddress}`;
        console.log(`Fetching Internal API: ${internalUrl}`);

        const data = await page.evaluate(async (url) => {
            try {
                const response = await fetch(url, {
                    headers: {
                        'accept': 'application/json, text/plain, */*',
                        'x-requested-with': 'XMLHttpRequest'
                    }
                });
                return await response.json();
            } catch (err: any) {
                return { error: err.toString() };
            }
        }, internalUrl);

        console.log("--- DATA KEYS ---");
        console.log(Object.keys(data));

        console.log("\n--- SECURITY (TA) ---");
        console.log(JSON.stringify(data.ta || "N/A", null, 2));

        console.log("\n--- CMS (Metadata) ---");
        // Looking for holders, description, social links
        const cms = data.cms || {};
        console.log("Keys:", Object.keys(cms));
        console.log("Holders Object:", cms.holders); // Check if this is where the count is

        console.log("\n--- GP (Price/Liquidity?) ---");
        // often contains price, liquidity
        console.log(JSON.stringify(data.gp || "N/A", null, 2));

        console.log("\n--- CB (Coinbase/Chart?) ---");
        console.log(JSON.stringify(data.cb || "N/A", null, 2));

        console.log("\n--- QI (Quote Info?) ---");
        console.log(JSON.stringify(data.qi || "N/A", null, 2));

        console.log("\n--- PAIR & PRICE & LIQUIDITY SEARCH ---");
        // Let's dump the first level of everything that looks like a number or object with numbers
        for (const key of Object.keys(data)) {
            if (['holders', 'ta', 'cms'].includes(key)) continue;
            console.log(`Key: ${key}`, JSON.stringify(data[key], null, 2).substring(0, 300));
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        if (browser) await browser.close();
    }
}

checkInternalDexApi();
