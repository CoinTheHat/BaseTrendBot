import { TokenSnapshot, MemeMatchResult, ScoreResult, ScoreBreakdown } from '../models/types';
import { config } from '../config/env';

export class ScoringEngine {

    score(token: TokenSnapshot, matchResult: MemeMatchResult): ScoreResult {
        let totalScore = 0;
        const breakdown: ScoreBreakdown[] = [];

        // --- 0. STRICT HARD GATES (Firewall) ---
        // These MUST be checked first. If failed, score is 0 and rejected immediately.
        const liq = token.liquidityUsd || 0;
        const mc = token.marketCapUsd || 0;
        const liqMcRatio = mc > 0 ? liq / mc : 0;

        // Gate 1: Unplayable Liquidity
        if (liq < 5000) {
            return { totalScore: 0, breakdown: [{ factor: 'Gate', points: 0, details: '🚫 Liq < $5k' }], phase: 'REJECTED_RISK' };
        }

        // Gate 2: Suspicious Liquidity Structure (Potential Rug/Honeypot)
        // Ratio > 90% usually means dev added all supply to LP or weird price manipulation
        if (liqMcRatio > 0.90) {
            return { totalScore: 0, breakdown: [{ factor: 'Gate', points: 0, details: '🚫 Liq > 90% MC (Scam Risk)' }], phase: 'REJECTED_RISK' };
        }


        // --- 1. MARKET CAP SEGMENTATION (Context-Aware) ---
        // Scale: 0-100. Max Segment Points: 50.
        let segment = 'UNKNOWN';

        if (mc < 10000) {
            segment = 'MICRO'; // Too early
            totalScore = 0;
            breakdown.push({ factor: 'MC Segment', points: 0, details: '🚫 Micro Cap (<$10k) - Too Risky' });
            return { totalScore, breakdown, phase: 'REJECTED_RISK' };
        } else if (mc < 50000) {
            segment = 'SEED'; // High Risk / Small Size
            totalScore += 30; // Base Entry
            breakdown.push({ factor: 'MC Segment', points: 30, details: '🌱 Seed Stage ($10k-$50k)' });
        } else if (mc < 250000) {
            segment = 'GOLDEN'; // Optimal Sniper Zone
            totalScore += 50; // Strong Base
            breakdown.push({ factor: 'MC Segment', points: 50, details: '🏆 Golden Zone ($50k-$250k)' });
        } else {
            segment = 'RUNNER'; // Breakout Only
            totalScore += 20; // Needs strong momentum to pass
            breakdown.push({ factor: 'MC Segment', points: 20, details: '🏃 Runner Zone (>$250k)' });
        }

        // --- 2. MOMENTUM (Txns & Speed > Volume) ---
        // Max Points: 25
        // Using `txs5m` (Buys + Sells) as proxy for speed
        const txs = token.txs5m || { buys: 0, sells: 0 };
        const totalTx = txs.buys + txs.sells;
        const buyRatio = totalTx > 0 ? txs.buys / totalTx : 0;

        // A. Activity Velocity
        if (totalTx > 100) { // Hyper Active (>20 tx/min)
            totalScore += 15;
            breakdown.push({ factor: 'Velocity', points: 15, details: '🚀 Hyper Active (>100 tx/5m)' });
        } else if (totalTx > 40) { // Active (>8 tx/min)
            totalScore += 10;
            breakdown.push({ factor: 'Velocity', points: 10, details: '⚡ Active (>40 tx/5m)' });
        } else if (totalTx < 10) { // Dead
            totalScore -= 20;
            breakdown.push({ factor: 'Velocity', points: -20, details: '💤 Low Activity (<10 tx/5m)' });
        }

        // B. Buy Pressure (Context-Aware)
        // Max Points: 15
        // In Seed/Golden, we want diverse buying. In Runner, we want breakouts.
        if (buyRatio > 0.60 && txs.buys > 15) {
            totalScore += 15;
            breakdown.push({ factor: 'Pressure', points: 15, details: `🔥 Strong Buys (${(buyRatio * 100).toFixed(0)}%)` });
        } else if (buyRatio < 0.40) {
            totalScore -= 10;
            breakdown.push({ factor: 'Pressure', points: -10, details: '🐻 Sell Heavy' });
        }

        // --- 3. LIQUIDITY QUALITY ---
        // Hard gates passed, now check quality

        // A. Burned/Locked Status (Premium Safety)
        if (token.lpBurned) {
            totalScore += 15;
            breakdown.push({ factor: 'Liquidity Safety', points: 15, details: '🔥 LP Burned (100%)' });
        } else if (token.lpLockedPercent && token.lpLockedPercent >= 90) {
            totalScore += 10;
            breakdown.push({ factor: 'Liquidity Safety', points: 10, details: `🔒 LP Locked (${token.lpLockedPercent.toFixed(1)}%)` });
        } else {
            totalScore += 0;
            breakdown.push({ factor: 'Liquidity Safety', points: 0, details: '⚠️ LP Open / Unknown' });
        }

        // B. Healthy Floor Check (Ratio)
        if (liqMcRatio < 0.10) {
            totalScore -= 10;
            breakdown.push({ factor: 'Liquidity Ratio', points: -10, details: '⚠️ Thin Liquidity (<10% MC)' });
        }

        // --- 4. FAKE PUMP / SCAM DETECTION (Segment-Aware) ---
        const priceChange = token.priceChange5m || 0;

        // Definition: High Price Jump + Low Buys = Artificial
        let minBuysForPump = 10;
        let maxChangeTolerance = 40;

        // Stricter for Seed Caps (Easier to manipulate)
        if (segment === 'SEED') {
            minBuysForPump = 20; // Needs more participation to prove it's real
            maxChangeTolerance = 30; // Lower tolerance for huge candles
        }

        if (priceChange > maxChangeTolerance && txs.buys < minBuysForPump) {
            totalScore = 0; // KILL IT
            breakdown.push({ factor: 'Fake Pump', points: -99, details: `🚨 Fake Pump (+${priceChange.toFixed(0)}% w/ low buy txns)` });
            return { totalScore, breakdown, phase: 'REJECTED_RISK' };
        }

        // Rule: Price crash
        if (priceChange < -20) {
            totalScore -= 20;
            breakdown.push({ factor: 'Price Action', points: -20, details: '📉 Dumping (-20%)' });
        }

        // --- 5. MEME BONUS (Reduced Impact) ---
        // Max Points: 5
        if (matchResult.memeMatch) {
            totalScore += 5;
            breakdown.push({ factor: 'Meme Match', points: 5, details: `Meme Bonus (${matchResult.matchedMeme?.phrase})` });
        }

        // --- 6. AGE SEGMENT SCORING ---
        // Max Points: 10
        // Using createdAt if available
        if (token.createdAt) {
            const ageMins = (Date.now() - token.createdAt.getTime()) / (60 * 1000);

            if (ageMins <= 10) {
                totalScore += 10; // Aggressive Sniper Zone
                breakdown.push({ factor: 'Freshness', points: 10, details: '👶 Newborn (<10m)' });
            } else if (ageMins <= 30) {
                totalScore += 5; // Optimal
                breakdown.push({ factor: 'Freshness', points: 5, details: '⚡ Early (<30m)' });
            } else if (ageMins > 240) { // > 4 hours
                totalScore -= 10; // Old
                breakdown.push({ factor: 'Freshness', points: -10, details: '👴 Old (>4h)' });
            }
        }

        // Normalize / Clamp Logic
        // Max Theoretical: 50 (Golden) + 15 (Vel) + 15 (Press) + 5 (Meme) + 10 (Age) = 95.
        // Alert Threshold: 70.
        totalScore = Math.min(Math.max(totalScore, 0), 100);

        return {
            totalScore,
            breakdown,
            phase: totalScore >= 70 ? 'SPOTTED' : 'TRACKING'
        };
    }
}
