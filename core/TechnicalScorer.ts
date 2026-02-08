import { TokenSnapshot } from '../models/types';

export interface TechnicalScore {
    mcScore: number;          // 20 pts max
    liquidityScore: number;   // 10 pts max
    distributionScore: number; // 10 pts max
    lpScore: number;           // 10 pts max
    ageScore: number;          // 5 pts max
    total: number;
}

/**
 * PHASE 2: TECHNICAL SCORING (50 Pts Max Base)
 */
export function calculateTechnicalScore(token: TokenSnapshot): TechnicalScore {
    let score: TechnicalScore = {
        mcScore: 0,
        liquidityScore: 0,
        distributionScore: 0,
        lpScore: 0,
        ageScore: 0,
        total: 0
    };

    const mc = token.marketCapUsd || 0;
    const liq = token.liquidityUsd || 0;
    const holders = token.holderCount || 0;
    const top10Pct = token.top10HoldersSupply || 0;
    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;

    // 1. MARKET CAP SCORE (20 pts)
    // Favoring the $100k - $500k zone for established trust
    if (mc >= 10000 && mc < 50000) {
        score.mcScore = 5;
    } else if (mc >= 50000 && mc < 100000) {
        score.mcScore = 12;
    } else if (mc >= 100000 && mc < 300000) {
        score.mcScore = 20; // GOLDEN ZONE
    } else if (mc >= 300000 && mc <= 1000000) {
        score.mcScore = 15;
    } else {
        score.mcScore = 0;
    }

    // 2. LIQUIDITY/MC RATIO SCORE (10 pts)
    // Master Logic: Ratio >= 15% is full points
    const liqRatio = mc > 0 ? (liq / mc) : 0;
    if (liqRatio >= 0.15) {
        score.liquidityScore = 10;
    } else if (liqRatio >= 0.10) {
        score.liquidityScore = 7;
    } else if (liqRatio >= 0.05) {
        score.liquidityScore = 3;
    } else {
        score.liquidityScore = 0;
    }

    // 3. HOLDER DISTRIBUTION SCORE (10 pts)
    // Master Logic: Top 10 < 30% is safe
    if (top10Pct < 20) {
        score.distributionScore = 10;
    } else if (top10Pct >= 20 && top10Pct < 30) {
        score.distributionScore = 7;
    } else if (top10Pct >= 30 && top10Pct < 35) {
        score.distributionScore = 2;
    } else if (top10Pct >= 35) {
        // Whale Penalty: Top 10 >= 35% => -20 points penalty
        score.distributionScore = -20;
    }

    // 4. LP SECURITY SCORE (10 pts)
    // Master Logic: LP Burned or %80+ Locked
    const isLocked = (token.lpLockedPercent || 0) >= 80;
    const isBurned = token.lpBurned || false;
    if (isLocked || isBurned) {
        score.lpScore = 10;
    }

    // 5. AGE SCORE (5 pts)
    // Reward fresh tokens < 4h (240 mins)
    if (holders < 2500) {
        if (ageMins >= 20 && ageMins < 45) {
            score.ageScore = 5;
        } else if (ageMins >= 45 && ageMins < 120) {
            score.ageScore = 3;
        } else if (ageMins >= 120 && ageMins < 240) {
            score.ageScore = 1;
        }
    }

    // TOTAL (Capped at 50 per Master Logic)
    score.total = score.mcScore + score.liquidityScore + score.distributionScore + score.lpScore + score.ageScore;
    score.total = Math.max(0, Math.min(50, score.total));

    return score;
}
