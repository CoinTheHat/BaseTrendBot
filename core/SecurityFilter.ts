import { TokenSnapshot } from '../models/types';
import { logger } from '../utils/Logger';

export interface HardFilterResult {
    passed: boolean;
    reason?: string;
}

/**
 * PHASE 1: HARD FILTERS v6 (Security Firewall)
 * Base Chain adapted from Solana v6 system
 * 
 * Gate Filtreleri (Sırayla uygulanır):
 * 1. Blacklist (yasaklı kelimeler)
 * 2. Liq < $5k → RED
 * 3. Liq/MC > %90 → RED
 * 4. Liq/MC < %5 → RED
 * 5. %5-10 + Liq < $20k → RED
 * 6. MC > $500k → RED
 * 7. Yaş > 24h → RED
 * 8. Fake Pump: +%40 fiyat + <10 buy → RED
 * 9. Mintable/Pausable → RED
 * 10. Top10 > %50 → RED
 * 11. Holder < 50 (yaşa göre değişken) → RED
 */
export function applyHardFilters(token: TokenSnapshot): HardFilterResult {
    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;
    const liq = token.liquidityUsd || 0;
    const mc = token.marketCapUsd || 0;
    const holders = token.holderCount || 0;
    const top10Percent = token.top10HoldersSupply || 0;
    const liqRatio = mc > 0 ? (liq / mc) : 0;
    const liqRatioPct = liqRatio * 100;
    const priceChange5m = token.priceChange5m || 0;
    const txs5m = token.txs5m || { buys: 0, sells: 0 };

    // 1. Age check (20m - 24h / 1440m)
    // v6: Yaş > 24h → RED
    if (ageMins < 20) {
        return { passed: false, reason: "TOO_YOUNG" };
    }
    if (ageMins > 1440) {
        return { passed: false, reason: "TOO_OLD" };
    }

    // 2. Liquidity Check v6
    // v6: Liq < $5k → RED
    if (liq < 5000) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Liq < $5k ($${liq.toFixed(0)})`);
        return { passed: false, reason: "LIQUIDITY_TOO_LOW" };
    }

    // 3. Liquidity/MC Ratio Checks v6
    // v6: Liq/MC > %90 → RED
    if (liqRatioPct > 90) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Liq/MC > 90% (${liqRatioPct.toFixed(1)}%)`);
        return { passed: false, reason: "LIQ_MC_RATIO_TOO_HIGH" };
    }

    // v6: Liq/MC < %5 → RED
    if (liqRatioPct < 5) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Liq/MC < 5% (${liqRatioPct.toFixed(1)}%)`);
        return { passed: false, reason: "LIQ_MC_RATIO_TOO_LOW" };
    }

    // v6: %5-10 + Liq < $20k → RED
    if (liqRatioPct >= 5 && liqRatioPct < 10 && liq < 20000) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Liq/MC 5-10% + Liq < $20k ($${liq.toFixed(0)})`);
        return { passed: false, reason: "LOW_LIQ_IN_SAFE_ZONE" };
    }

    // 4. Market Cap Check v6
    // v6: MC > $500k → RED
    if (mc > 500000) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: MC > $500k ($${mc.toFixed(0)})`);
        return { passed: false, reason: "MC_TOO_HIGH" };
    }

    // 5. Minimum Market Cap ($10k) - Keep existing
    if (mc < 10000) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: MC < $10k ($${mc.toFixed(0)})`);
        return { passed: false, reason: "MC_TOO_LOW" };
    }

    // 6. Fake Pump Detection v6
    // v6: +%40 fiyat + <10 buy → RED
    if (priceChange5m > 40 && txs5m.buys < 10) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Fake Pump (+${priceChange5m.toFixed(0)}% price, ${txs5m.buys} buys)`);
        return { passed: false, reason: "FAKE_PUMP" };
    }

    // 7. Mintable/Pausable Check v6 (ERC-20 specific)
    // v6: Mintable/Pausable → RED
    // In Base/EVM, these are isMintable and isFreezable flags
    if (token.isMintable || token.isFreezable) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Mintable=${token.isMintable}, Freezable=${token.isFreezable}`);
        return { passed: false, reason: "MINTABLE_OR_PAUSABLE" };
    }

    // 8. Whale Dominance v6
    // v6: Top10 > %50 → RED
    if (top10Percent > 50) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Top10 > 50% (${top10Percent.toFixed(1)}%)`);
        return { passed: false, reason: "WHALE_TRAP" };
    }

    // 9. Holder Count Check v6
    // v6: Holder < 50 (yaşa göre değişken)
    // For very new tokens (< 60 mins), require at least 30 holders
    // For older tokens, require at least 50 holders
    let minHolders = 50;
    if (ageMins < 60) {
        minHolders = 30;
    }

    if (holders < minHolders) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Holders < ${minHolders} (${holders}), Age: ${ageMins.toFixed(0)}m`);
        return { passed: false, reason: "NOT_ENOUGH_HOLDERS" };
    }

    // 10. Blacklist Check
    const blacklist = ["nazi", "isis", "terror", "drug", "hitman", "pedo", "child", "rape", "hitler", "jew", "trump", "biden"];
    const tokenText = (token.name + " " + token.symbol).toLowerCase();
    for (const word of blacklist) {
        if (tokenText.includes(word)) {
            logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Blacklisted word '${word}'`);
            return { passed: false, reason: "BLACKLISTED_NAME" };
        }
    }

    // 11. Liquidity Lock Control (with Fallback) - Keep existing logic
    const isLocked = token.lpLockedPercent ? token.lpLockedPercent >= 80 : false;
    const isBurned = token.lpBurned || false;
    const lpSafe = isLocked || isBurned;
    const fallbackPassed = top10Percent < 25 && holders > 100;

    if (!lpSafe && !fallbackPassed) {
        logger.info(`[Security v6] ❌ REJECTED ${token.symbol}: Low Lock (Safe: ${lpSafe}, Fallback: ${fallbackPassed})`);
        return { passed: false, reason: "RUG_RISK_LOW_LOCK" };
    }

    return { passed: true };
}
