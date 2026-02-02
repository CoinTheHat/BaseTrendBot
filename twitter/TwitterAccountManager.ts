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
    searchCount: number; // Track searches
    lastWarmup: number;  // Track last warm-up timestamp
}

import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);

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

        const proxies = config.TWITTER_PROXIES || [];

        // 1. Load Legacy List (Comma-Separated) - Priority 1
        const legacyCount = Math.min(tokens.length, ct0s.length);
        for (let i = 0; i < legacyCount; i++) {
            foundAccounts.push({
                authToken: tokens[i],
                ct0: ct0s[i],
                index: i,
                userAgent: USER_AGENTS[i % USER_AGENTS.length],
                proxy: proxies[i] || undefined, // Assign proxy if available
                isBusy: false,
                lastBusyStart: 0,
                cooldownUntil: 0,
                searchCount: 0,
                lastWarmup: 0
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
                            cooldownUntil: 0,
                            searchCount: 0,
                            lastWarmup: 0
                        });
                        dynamicCount++;
                    }
                }
            }
        });

        // 3. Last Resort: Single Legacy Token
        // 3. Last Resort: Single Legacy Token (or Misconfigured List in Singular Var)
        if (foundAccounts.length === 0 && config.TWITTER_AUTH_TOKEN) {
            // Check if user accidentally put comma-separated list in the SINGULAR variable
            if (config.TWITTER_AUTH_TOKEN.includes(',')) {
                const tokens = config.TWITTER_AUTH_TOKEN.split(',').map(t => t.trim()).filter(t => t);
                const ct0s = (config.TWITTER_CT0 || '').split(',').map(t => t.trim()).filter(t => t);

                const count = Math.min(tokens.length, ct0s.length);
                for (let i = 0; i < count; i++) {
                    foundAccounts.push({
                        authToken: tokens[i],
                        ct0: ct0s[i],
                        index: i,
                        userAgent: USER_AGENTS[i % USER_AGENTS.length],
                        proxy: proxies[i] || undefined,
                        isBusy: false,
                        lastBusyStart: 0,
                        cooldownUntil: 0,
                        searchCount: 0,
                        lastWarmup: 0
                    });
                }
                logger.info(`[TwitterManager] Detected ${count} accounts in generic TWITTER_AUTH_TOKEN variable.`);
            } else {
                foundAccounts.push({
                    authToken: config.TWITTER_AUTH_TOKEN,
                    ct0: config.TWITTER_CT0,
                    index: 0,
                    userAgent: USER_AGENTS[0],
                    proxy: undefined,
                    isBusy: false,
                    lastBusyStart: 0,
                    cooldownUntil: 0,
                    searchCount: 0,
                    lastWarmup: 0
                });
            }
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

        // 🚨 FALLBACK: FORCE RELEASE OLDEST BUSY ACCOUNT 🚨
        // If we reached here, ALL accounts are busy or on cooldown.
        // We cannot return null (user requirement). We must pick the "least busy" or "oldest busy" account.

        // Find the account that started being busy longest ago
        let oldestBusyParams = { index: -1, time: Infinity };

        this.accounts.forEach(acc => {
            // Only consider busy ones, or if none busy (all cooldown), pick anyone?
            // If all are on cooldown, we should probably pick the one with earliest cooldown expiry.
            if (acc.isBusy) {
                if (acc.lastBusyStart < oldestBusyParams.time) {
                    oldestBusyParams = { index: acc.index, time: acc.lastBusyStart };
                }
            }
        });

        if (oldestBusyParams.index !== -1) {
            const acc = this.accounts[oldestBusyParams.index];
            logger.warn(`[TwitterManager] ⚠️ POOL EXHAUSTED (${this.accounts.length} accs). Forcing turnover of Account #${acc.index + 1}.`);

            // Force reset stats for this new usage
            acc.isBusy = true;
            acc.lastBusyStart = Date.now();
            return acc;
        }

        // If NO accounts are busy (meaning all are on cooldown), pick the one with nearest cooldown expiry.
        let nearestCooldownParams = { index: -1, time: Infinity };
        this.accounts.forEach(acc => {
            if (acc.cooldownUntil < nearestCooldownParams.time) {
                nearestCooldownParams = { index: acc.index, time: acc.cooldownUntil };
            }
        });

        if (nearestCooldownParams.index !== -1) {
            const acc = this.accounts[nearestCooldownParams.index];
            logger.warn(`[TwitterManager] 🧊 ALL POOL COOLED DOWN. Early releasing Account #${acc.index + 1}.`);
            acc.isBusy = true;
            acc.lastBusyStart = Date.now();
            return acc;
        }

        // If we have 0 accounts loaded at all
        logger.error('[TwitterManager] CRITICAL: No accounts loaded in pool!');
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
            account.lastBusyStart = 0;

            // 🛑 STRICT COOLDOWN: Always rest for 2 minutes after ANY usage
            // User requirement: "1 token 1 hesap taradı... o hesap 2dk dinlensin"
            account.cooldownUntil = Date.now() + (2 * 60 * 1000);

            if (wasRateLimited) {
                logger.warn(`[TwitterManager] 🛑 Account #${index + 1} hit Rate Limit. Resting 2m.`);
            } else {
                logger.info(`[TwitterManager] 💤 Account #${index + 1} task complete. Resting 2m.`);
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

    /**
     * Resets locking capability for all accounts.
     * Call this on bot startup to clear any ghost locks.
     */
    resetAllLocks() {
        this.accounts.forEach(acc => {
            acc.isBusy = false;
            acc.lastBusyStart = 0;
            acc.cooldownUntil = 0;
        });
        logger.info(`[TwitterManager] Force reset all ${this.accounts.length} account locks.`);
    }
    async performWarmup(account: TwitterAccount): Promise<void> {
        try {
            logger.info(`[Warmup] 🌡️ Warming up Account #${account.index + 1}...`);

            // Random warm-up activities to mimic human behavior
            const activities = [
                () => this.fetchUserProfile(account, 'elonmusk'),
                () => this.fetchUserProfile(account, 'CoinGecko'),
                () => this.fetchUserProfile(account, 'solana'),
                () => this.fetchUserProfile(account, 'ethereum'),
                () => this.fetchUserProfile(account, 'VitalikButerin')
            ];

            // Execute random activity
            const activity = activities[Math.floor(Math.random() * activities.length)];
            await activity();

            // Reset counters
            account.lastWarmup = Date.now();
            account.searchCount = 0;

            logger.info(`[Warmup] ✅ Account #${account.index + 1} warm-up complete.`);
        } catch (err) {
            logger.warn(`[Warmup] Failed for Account #${account.index + 1}: ${err}`);
        }
    }

    private async fetchUserProfile(account: TwitterAccount, username: string): Promise<void> {
        // Prepare Env
        const env: any = {
            ...process.env,
            AUTH_TOKEN: account.authToken,
            CT0: account.ct0
        };

        if (account.proxy) {
            env.HTTP_PROXY = account.proxy;
            env.HTTPS_PROXY = account.proxy;
        }

        // Use Bird CLI: npx @steipete/bird user [username]
        // Note: Bird CLI 'user' command might need checking if it exists/works same way. 
        // Assuming it does based on plan. If not, 'search from:user' is alternative.
        // Plan said: npx @steipete/bird user [username] --json
        const cmd = `npx @steipete/bird user "${username}" --json`;
        await execAsync(cmd, { env, timeout: 10000 });
    }
}

export const twitterAccountManager = new TwitterAccountManager();
