import { config } from '../config/env';
import { logger } from '../utils/Logger';


export interface TwitterAccount {
    authToken: string;
    ct0: string;
    index: number;
    userAgent: string;
    proxy?: string;
    isBusy: boolean;
    lastBusyStart: number; // For Deadlock Detection
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
        const foundAccounts: TwitterAccount[] = [];

        // 1. Load Legacy List (Comma-Separated) - Priority 1
        const legacyCount = Math.min(tokens.length, ct0s.length);
        for (let i = 0; i < legacyCount; i++) {
            foundAccounts.push({
                authToken: tokens[i],
                ct0: ct0s[i],
                index: i,
                userAgent: USER_AGENTS[i % USER_AGENTS.length],
                isBusy: false,
                lastBusyStart: 0,
                cooldownUntil: 0
            });
        }

        // 2. Load Dynamic Env Vars (TWITTER_AUTH_TOKEN_1, _2, etc.)
        // Scan keys for TWITTER_AUTH_TOKEN_X prefix
        const envKeys = Object.keys(process.env);
        let dynamicCount = 0;

        envKeys.forEach(key => {
            if (key.match(/^TWITTER_AUTH_TOKEN_\d+$/)) {
                const suffix = key.split('_').pop(); // '1', '2'
                const authToken = process.env[key];
                const ct0Key = `TWITTER_CT0_${suffix}`;
                const ct0 = process.env[ct0Key];

                if (authToken && ct0) {
                    // Check for duplicates (avoid loading same token twice if it's also in the list)
                    const isDuplicate = foundAccounts.some(a => a.authToken === authToken);
                    if (!isDuplicate) {
                        foundAccounts.push({
                            authToken: authToken,
                            ct0: ct0,
                            index: foundAccounts.length, // Append Index
                            userAgent: USER_AGENTS[foundAccounts.length % USER_AGENTS.length],
                            isBusy: false,
                            lastBusyStart: 0,
                            cooldownUntil: 0
                        });
                        dynamicCount++;
                    }
                }
            }
        });

        // 3. Last Resort: Single Legacy Token
        if (foundAccounts.length === 0 && config.TWITTER_AUTH_TOKEN) {
            foundAccounts.push({
                authToken: config.TWITTER_AUTH_TOKEN,
                ct0: config.TWITTER_CT0,
                index: 0,
                userAgent: USER_AGENTS[0],
                isBusy: false,
                lastBusyStart: 0,
                cooldownUntil: 0
            });
        }

        this.accounts = foundAccounts;
        logger.info(`[TwitterManager] Loaded ${this.accounts.length} accounts (Legacy: ${legacyCount}, Dynamic: ${dynamicCount}).`);
    }

    /**
     * Returns the next available account that is NOT busy and NOT on cooldown.
     * Sets isBusy = true immediately.
     */
    getAvailableAccount(): TwitterAccount | null {
        if (this.accounts.length === 0) return null;

        const now = Date.now();

        // 🚨 DEADLOCK SAFETY CHECK 🚨
        this.accounts.forEach(acc => {
            if (acc.isBusy && acc.lastBusyStart > 0) {
                const busyDuration = now - acc.lastBusyStart;
                if (busyDuration > 180000) { // 3 Minutes
                    logger.warn(`[TwitterManager] 🚨 DEADLOCK DETECTED on Account #${acc.index + 1}. Busy for ${(busyDuration / 1000).toFixed(1)}s. FORCE RELEASING.`);
                    acc.isBusy = false;
                    acc.lastBusyStart = 0;
                    acc.cooldownUntil = now + 5000; // Small penalty
                }
            }
        });

        // Try accounts starting from currentIndex
        for (let i = 0; i < this.accounts.length; i++) {
            const ptr = (this.currentIndex + i) % this.accounts.length;
            const account = this.accounts[ptr];

            if (!account.isBusy && now > account.cooldownUntil) {
                this.currentIndex = (ptr + 1) % this.accounts.length;
                account.isBusy = true; // CLAIM IT
                account.lastBusyStart = Date.now();
                return account;
            }
        }

        return null; // All busy or cooled down
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
            account.lastBusyStart = 0;

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
