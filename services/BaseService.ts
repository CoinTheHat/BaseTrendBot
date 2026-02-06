import { JsonRpcProvider } from 'ethers';
import { config } from '../config/env';
import { logger } from '../utils/Logger';

export class BaseService {
    private provider: JsonRpcProvider;

    constructor() {
        const rpcUrl = config.BASE_RPC_URL;

        if (!rpcUrl || (!rpcUrl.startsWith('http://') && !rpcUrl.startsWith('https://'))) {
            logger.error(`[BaseService] CRITICAL: Invalid BASE_RPC_URL: "${rpcUrl}". Check Environment Variables!`);
            throw new Error('BASE_RPC_URL is missing or invalid. Please update configuration.');
        }

        logger.info(`[BaseService] Initializing with RPC: ${rpcUrl}`);
        this.provider = new JsonRpcProvider(rpcUrl);
    }

    async getBlockNumber(): Promise<number> {
        return await this.provider.getBlockNumber();
    }

    // Add generic EVM calls here if needed later
}
