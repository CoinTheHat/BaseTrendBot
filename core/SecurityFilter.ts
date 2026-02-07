import { TokenSnapshot } from '../models/types';
import { logger } from '../utils/Logger';

export interface HardFilterResult {
    passed: boolean;
    reason?: string;
}

/**
 * PHASE 1: HARD FILTERS (Security Firewall)
 * If any filter fails, the coin is rejected immediately.
 */
export function applyHardFilters(token: TokenSnapshot): HardFilterResult {
    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;
    const liq = token.liquidityUsd || 0;
    const mc = token.marketCapUsd || 0;
    const holders = token.holderCount || 0;
    const top10Percent = token.top10HoldersSupply || 0;
    const isLocked = token.lpLockedPercent ? token.lpLockedPercent >= 80 : false;
    const isBurned = token.lpBurned || false;

    // 1. Age check (20m - 24h)
    // Note: Basic age filter is also in TokenScanJob.ts, but this adds a second layer.
    if (ageMins < 20) {
        return { passed: false, reason: "TOO_YOUNG" };
    }
    if (ageMins > 1440) {
        return { passed: false, reason: "TOO_OLD" };
    }

    // 2. Liquidity Lock Control (with Fallback)
    // Fallback: (Top 10 < 25% AND Holders > 600)
    const lpSafe = isLocked || isBurned;
    const fallbackPassed = top10Percent < 25 && holders > 600;

    if (!lpSafe && !fallbackPassed) {
        return { passed: false, reason: "RUG_RISK_LOW_LOCK" };
    }

    // 3. Minimum Liquidity ($5k)
    if (liq < 5000) {
        return { passed: false, reason: "LIQUIDITY_TOO_LOW" };
    }

    // 4. Minimum Market Cap ($10k)
    if (mc < 10000) {
        return { passed: false, reason: "MC_TOO_LOW" };
    }

    // 5. Minimum Holder Count (150)
    if (holders < 150) {
        return { passed: false, reason: "NOT_ENOUGH_HOLDERS" };
    }

    // 6. Whale Dominance (Top 10 holder > 50% is HARD REJECT)
    if (top10Percent > 50) {
        return { passed: false, reason: "WHALE_TRAP" };
    }

    // 7. Blacklist Check
    const blacklist = ["nazi", "isis", "terror", "drug", "hitman", "pedo", "child", "rape", "hitler", "jew"];
    const tokenText = (token.name + " " + token.symbol).toLowerCase();
    for (const word of blacklist) {
        if (tokenText.includes(word)) {
            return { passed: false, reason: "BLACKLISTED_NAME" };
        }
    }

    return { passed: true };
}
