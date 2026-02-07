import { TokenSnapshot } from '../models/types';

export interface TechnicalScore {
    mcScore: number;          // 20 pts max
    liquidityScore: number;   // 10 pts max
    distributionScore: number; // 15 pts max
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
        ageScore: 0,
        total: 0
    };

    const mc = token.marketCapUsd || 0;
    const liq = token.liquidityUsd || 0;
    const holders = token.holderCount || 0;
    const top10Pct = token.top10HoldersSupply || 0;
    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;

    // 1. MARKET CAP SCORE (20 pts)
    if (mc >= 10000 && mc < 30000) {
        score.mcScore = 15;
    } else if (mc >= 30000 && mc < 80000) {
        score.mcScore = 20; // GOLDEN ZONE
    } else if (mc >= 80000 && mc < 200000) {
        score.mcScore = 15;
    } else if (mc >= 200000 && mc < 500000) {
        score.mcScore = 8;
    } else {
        score.mcScore = 0; // Too high or handled elsewhere
    }

    // 2. LIQUIDITY SCORE (10 pts)
    if (liq >= 5000 && liq < 10000) {
        score.liquidityScore = 5;
    } else if (liq >= 10000 && liq < 30000) {
        score.liquidityScore = 10;
    } else if (liq >= 30000) {
        score.liquidityScore = 8; // High liquidity relative to MC might be lower impact
    }

    // 3. HOLDER DISTRIBUTION SCORE (15 pts)
    if (top10Pct < 20) {
        score.distributionScore = 15;
    } else if (top10Pct >= 20 && top10Pct < 30) {
        score.distributionScore = 10;
    } else if (top10Pct >= 30 && top10Pct < 35) {
        score.distributionScore = 3;
    } else if (top10Pct >= 35) {
        // Whale Penalty: Top 10 >= 35% => -20 points penalty (Per User Request)
        score.distributionScore = -20;
    }

    // 4. AGE SCORE (5 pts)
    // Reward fresh tokens, but REMOVE bonus if holders >= 2500 (Per User Request)
    if (holders < 2500) {
        if (ageMins >= 20 && ageMins < 45) {
            score.ageScore = 5;
        } else if (ageMins >= 45 && ageMins < 120) {
            score.ageScore = 3;
        } else if (ageMins >= 120 && ageMins < 240) {
            score.ageScore = 1;
        }
    }

    // TOTAL
    score.total = score.mcScore + score.liquidityScore + score.distributionScore + score.ageScore;

    return score;
}
