import axios from 'axios';
import { logger } from '../utils/Logger';

export class GoPlusService {
    private baseUrl = 'https://api.gopluslabs.io/api/v1';

    async checkToken(address: string, chain: 'solana' | 'base'): Promise<boolean> {
        try {
            let url = '';

            if (chain === 'solana') {
                url = `${this.baseUrl}/solana/token_security?contract_addresses=${address}`;
            } else {
                // Base chainId is 8453
                url = `${this.baseUrl}/token_security/8453?contract_addresses=${address}`;
            }

            const response = await axios.get(url, { timeout: 10000 });
            const data = response.data?.result?.[address.toLowerCase()] || response.data?.result?.[address];

            if (!data) {
                // If checking failed (API error or empty), default to SKIP (FALSE) to be safe or TRUE if lenient?
                // USER said: "If !isSafe ... SKIP functionality".
                // If we can't check, is it safe? Let's assume strictness.
                logger.warn(`[GoPlus] No data for ${address} on ${chain}. Assuming UNSAFE.`);
                return false;
            }

            // CHECK FLAGS
            // 1. Open Source (0 = Not, 1 = Yes)
            if (data.is_open_source === '0') {
                logger.warn(`[GoPlus] 🚨 ${address} is NOT Open Source. REJECTED.`);
                return false;
            }

            // 2. Honeypot (1 = Yes)
            if (data.is_honeypot === '1') {
                logger.warn(`[GoPlus] 🚨 ${address} is HONEYPOT. REJECTED.`);
                return false;
            }

            // 3. Mintable (1 = Yes)
            // Note: Some tokens are legitimately mintable but renounced. GoPlus usually flags 'owner_change_balance' etc.
            // Requirement was: "If mintable: 1 (Solana) -> CRITICAL RISK."
            // Assuming this applies strictly to Solana as requested.
            if (chain === 'solana' && data.mintable === '1') {
                logger.warn(`[GoPlus] 🚨 ${address} is MINTABLE (Solana). REJECTED.`);
                return false;
            }

            // If passed all checks
            return true;

        } catch (error: any) {
            logger.error(`[GoPlus] API Error checking ${address}: ${error.message}`);
            // Fail safe: If API errors, do we block?
            // "Your job is to protect ... REJECT IT." -> Block on error.
            return false;
        }
    }
}
