import axios from 'axios';
import { logger } from '../utils/Logger';

export interface GoPlusResult {
    isSafe: boolean;
    dangerReason?: string;
}

export class GoPlusService {
    private baseUrl = 'https://api.gopluslabs.io/api/v1';

    async checkSecurity(address: string): Promise<GoPlusResult> {
        try {
            // Base chainId is 8453
            const url = `${this.baseUrl}/token_security/8453?contract_addresses=${address}`;
            const response = await axios.get(url, { timeout: 10000 });
            const data = response.data?.result?.[address];

            if (!data) {
                logger.warn(`[GoPlus] No data for ${address}. Proceeding with caution.`);
                return { isSafe: true };
            }

            // CHECK FLAGS
            if (data.is_open_source === '0') {
                return { isSafe: false, dangerReason: 'NOT_OPEN_SOURCE' };
            }

            if (data.is_honeypot === '1') {
                return { isSafe: false, dangerReason: 'HONEYPOT' };
            }

            // checkToken was also checking is_mintable. 
            // In V3, TechnicalScorer handles it as penalty, but if it's a HARD REJECT in GoPlus, we keep it.
            if (data.is_mintable === '1') {
                return { isSafe: false, dangerReason: 'MINTABLE' };
            }

            return { isSafe: true };

        } catch (error: any) {
            logger.error(`[GoPlus] API Error checking ${address}: ${error.message}`);
            return { isSafe: false, dangerReason: 'API_ERROR' };
        }
    }

    // Keep legacy for compatibility
    async checkToken(address: string): Promise<boolean> {
        const res = await this.checkSecurity(address);
        return res.isSafe;
    }
}
