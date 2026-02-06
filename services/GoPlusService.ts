import axios from 'axios';
import { logger } from '../utils/Logger';

export class GoPlusService {
    private baseUrl = 'https://api.gopluslabs.io/api/v1';

    async checkToken(address: string): Promise<boolean> {
        try {
            // Base chainId is 8453
            const url = `${this.baseUrl}/token_security/8453?contract_addresses=${address}`;
            const response = await axios.get(url, { timeout: 10000 });
            const data = response.data?.result?.[address];

            if (!data) {
                logger.warn(`[GoPlus] No data for ${address}. Proceeding with caution (Assume SAFE).`);
                return true;
            }

            // CHECK FLAGS
            if (data.is_open_source === '0') {
                logger.warn(`[GoPlus] 🚨 ${address} is NOT Open Source. REJECTED.`);
                return false;
            }

            if (data.is_honeypot === '1') {
                logger.warn(`[GoPlus] 🚨 ${address} is HONEYPOT. REJECTED.`);
                return false;
            }

            if (data.is_mintable === '1') {
                logger.warn(`[GoPlus] 🚨 ${address} is MINTABLE. REJECTED.`);
                return false;
            }

            return true;

        } catch (error: any) {
            logger.error(`[GoPlus] API Error checking ${address}: ${error.message}`);
            return false;
        }
    }
}
