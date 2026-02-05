import axios from 'axios';
import { logger } from '../utils/Logger';

export interface GoPlusSecurity {
    safe: boolean;
    reason?: string;
    details?: any;
}

export class GoPlusService {
    // Base Chain ID: 8453
    private baseUrl = 'https://api.gopluslabs.io/api/v1/token_security/8453';

    async checkTokenSecurity(mint: string): Promise<GoPlusSecurity> {
        try {
            const response = await axios.get(this.baseUrl, {
                params: {
                    contract_addresses: mint
                },
                timeout: 5000
            });

            const data = response.data?.result?.[mint.toLowerCase()];
            if (!data) {
                // If not found, it might be too new. Treat as "Unknown" but safe-ish for now or fail safe?
                // Usually GoPlus is fast. If not found, imply caution.
                return { safe: true, reason: 'Scan Not Available (Too New)' };
            }

            // --- SECURITY CHECKS ---

            // 1. HoneyPot Check
            if (data.is_honeypot === "1") {
                return { safe: false, reason: 'HoneyPot Detected' };
            }

            // 2. Open Source
            if (data.is_open_source === "0") {
                return { safe: false, reason: 'Contract Not Verified (Closed Source)' };
            }

            // 3. Mintable (Careful - some valid tokens are mintable, but risk is high for memes)
            if (data.is_mintable === "1") {
                return { safe: false, reason: 'Mint Function Enabled' };
            }

            // 4. Proxy (Can change logic)
            if (data.is_proxy === "1") {
                return { safe: false, reason: 'Proxy Contract (Upgradable)' };
            }

            // 5. Ownership Renounced? ("owner_address" should be empty or null address)
            // Note: GoPlus returns owner_address. If it's a real wallet, dev can rug.
            if (data.owner_address && data.owner_address !== '0x0000000000000000000000000000000000000000') {
                // Allow if it's a known burner/locker, otherwise warn.
                // For strict mode:
                return { safe: false, reason: 'Ownership Not Renounced' };
            }

            // 6. Sell Tax / Buy Tax (Keep < 10% or similar)
            const buyTax = parseFloat(data.buy_tax || '0');
            const sellTax = parseFloat(data.sell_tax || '0');
            if (buyTax > 10 || sellTax > 10) {
                return { safe: false, reason: `High Tax (Buy: ${buyTax}%, Sell: ${sellTax}%)` };
            }

            return { safe: true, details: data };

        } catch (error: any) {
            logger.warn(`[GoPlus] Security check failed for ${mint}: ${error.message}`);
            // Fail open or closed? Failed API implies we don't know risks.
            // Let's return Safe=false to be secure.
            return { safe: false, reason: 'GoPlus API Error' };
        }
    }
}
