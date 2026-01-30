import { config } from '../config/env';
import { logger } from '../utils/Logger';


export interface TwitterAccount {
    authToken: string;
    ct0: string;
    index: number;
    userAgent: string;
    proxy?: string;
    isBusy: boolean;
    cooldownUntil: number;
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux i686; rv:109.0) Gecko/20100101 Firefox/121.0'
];

export class TwitterAccountManager {
    private accounts: TwitterAccount[] = [];
    private currentIndex: number = 0;

    constructor() {
        this.loadAccounts();
    }

    private loadAccounts() {
        const tokens = config.TWITTER_AUTH_TOKENS || [];
        const ct0s = config.TWITTER_CT0S || [];

        // Parallel arrays
        logger.info(`[TwitterManager] Config Check: Found ${tokens.length} Auth Tokens and ${ct0s.length} CT0s.`);
        const count = Math.min(tokens.length, ct0s.length);

        if (count === 0 && config.TWITTER_AUTH_TOKEN) {
            // Fallback to legacy single
            this.accounts.push({
                authToken: config.TWITTER_AUTH_TOKEN,
                ct0: config.TWITTER_CT0,
                index: 0,
                userAgent: USER_AGENTS[0],
                isBusy: false,
                cooldownUntil: 0
            });
        } else {
            for (let i = 0; i < count; i++) {
                this.accounts.push({
                    authToken: tokens[i],
                    ct0: ct0s[i],
                    index: i,
                    userAgent: USER_AGENTS[i % USER_AGENTS.length],
                    isBusy: false,
                    cooldownUntil: 0
                });
            }
        }

        if (this.accounts.length > 0) {
            logger.info(`[TwitterManager] Loaded ${this.accounts.length} accounts with fingerprinting.`);
        } else {
            logger.warn(`[TwitterManager] No accounts found.`);
        }
    }

    /**
     * Returns the next available account that is NOT busy and NOT on cooldown.
     * Sets isBusy = true immediately.
     */
    getAvailableAccount(): TwitterAccount | null {
        if (this.accounts.length === 0) return null;

        const now = Date.now();

        // Try accounts starting from currentIndex
        for (let i = 0; i < this.accounts.length; i++) {
            const ptr = (this.currentIndex + i) % this.accounts.length;
            const account = this.accounts[ptr];

            if (!account.isBusy && now > account.cooldownUntil) {
                this.currentIndex = (ptr + 1) % this.accounts.length;
                account.isBusy = true; // CLAIM IT
                return account;
            }
        }

        return null;
    }

    /**
     * Releases an account back to the pool.
     * @param index Account index
     * @param wasRateLimited If true, triggers 2m cooldown.
     */
    releaseAccount(index: number, wasRateLimited: boolean) {
        const account = this.accounts.find(a => a.index === index);
        if (account) {
            account.isBusy = false;

            if (wasRateLimited) {
                // 🛑 RATE LIMIT HIT: 5 Minute Penalty
                account.cooldownUntil = Date.now() + (5 * 60 * 1000);
                logger.warn(`[TwitterManager] Account #${index + 1} hit Rate Limit. Cooldown 5m until ${new Date(account.cooldownUntil).toTimeString().substring(0, 8)}`);
            } else {
                // ✅ STANDARD CYCLE: 30 Second Rest (Requested)
                account.cooldownUntil = Date.now() + (30 * 1000);
                logger.debug(`[TwitterManager] Account #${index + 1} released. Resting 30s.`);
            }
        }
    }

    // Deprecated alias for compatibility
    markUsed(account: TwitterAccount) {
        this.releaseAccount(account.index, false);
    }

    // Legacy generic getter (auto-busy)
    getNextAccount(): TwitterAccount | null {
        return this.getAvailableAccount();
    }


    getAccountCount(): number {
        return this.accounts.length;
    }
}

export const twitterAccountManager = new TwitterAccountManager();
