
import axios from 'axios';
import { logger } from '../utils/Logger';

async function verifyGoPlus() {
    const address = "0x532f27101965dd16442e59d40670faf5ebb142e4"; // BRETT address
    const url = `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`;

    logger.info(`FETCHING GoPlus for ${address}...`);
    try {
        const response = await axios.get(url, { timeout: 10000 });
        const data = response.data?.result?.[address];

        if (data) {
            logger.info("✅ GoPlus DATA:");
            logger.info(`Holder Count: ${data.holder_count}`);
            logger.info(`Lp Holder Count: ${data.lp_holder_count}`);
            logger.info(`Total Supply: ${data.total_supply}`);
            logger.info(`Is Mintable: ${data.is_mintable}`);
            logger.info(`Is Open Source: ${data.is_open_source}`);
            logger.info(`Is Proxy: ${data.is_proxy}`);
            logger.info(`Is Honeypot: ${data.is_honeypot}`);
            logger.info(`Owner Address: ${data.owner_address}`);
        } else {
            logger.error("❌ No Data found in GoPlus response.");
            logger.info(JSON.stringify(response.data));
        }
    } catch (err: any) {
        logger.error(`Error: ${err.message}`);
    }
}

verifyGoPlus();
