import { TokenSnapshot } from '../models/types';

/**
 * PHASE 2: FAKE PUMP DETECTION
 * Detects artificial price manipulation where price increases without matching organic volume.
 */
export function detectFakePump(token: TokenSnapshot): { detected: boolean; reason?: string } {
    const priceChange5m = token.priceChange5m || 0;
    const txs = token.txs5m || { buys: 0, sells: 0 };
    const buys5m = txs.buys;
    const sells5m = txs.sells;

    // 1. Fake Pump: High price jump but low buys
    // If price increased by 40%+ but there are fewer than 10 buy transactions
    if (priceChange5m > 40 && buys5m < 10) {
        return {
            detected: true,
            reason: `FAKE_PUMP: Price +${priceChange5m.toFixed(0)}% with only ${buys5m} buys`
        };
    }

    // 2. Price Manipulation: Sell volume much higher than buy volume but price is increasing
    // If price increased by 30%+ but sell transactions are more than double the buys
    if (priceChange5m > 30 && sells5m > (buys5m * 2)) {
        return {
            detected: true,
            reason: `MANIPULATION: Price +${priceChange5m.toFixed(0)}% despite high sell pressure (Sells: ${sells5m}, Buys: ${buys5m})`
        };
    }

    return { detected: false };
}
