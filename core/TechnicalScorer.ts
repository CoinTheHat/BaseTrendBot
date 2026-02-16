import { TokenSnapshot } from '../models/types';

export interface TechnicalScore {
    mcScore: number;           // 10 pts max
    liquidityScore: number;    // 8 pts max
    distributionScore: number;  // 10 pts max
    securityScore: number;     // 6 pts max
    ageScore: number;         // 6 pts max
    total: number;
}

/**
 * PHASE 2: TECHNICAL SCORING v6 (40 Pts Max)
 * Base Chain adapted from Solana v6 system
 */
export function calculateTechnicalScore(token: TokenSnapshot): TechnicalScore {
    let score: TechnicalScore = {
        mcScore: 0,
        liquidityScore: 0,
        distributionScore: 0,
        securityScore: 0,
        ageScore: 0,
        total: 0
    };

    const mc = token.marketCapUsd || 0;
    const liq = token.liquidityUsd || 0;
    const holders = token.holderCount || 0;
    const top10Pct = token.top10HoldersSupply || 0;
    const top1Pct = token.top10HoldersSupply ? token.top10HoldersSupply / 4 : 20; // Estimate top1 as ~25% of top10
    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;
    const lpLocked = token.lpLockedPercent || 0;
    const lpBurned = token.lpBurned || false;

    // 1. MARKET CAP SCORE (10 pts max)
    // v6: ≤$15k=10, ≤$40k=10, ≤$70k=8, ≤$100k=6, ≤$150k=3, ≤$300k=1
    if (mc <= 15000) {
        score.mcScore = 10;
    } else if (mc <= 40000) {
        score.mcScore = 10;
    } else if (mc <= 70000) {
        score.mcScore = 8;
    } else if (mc <= 100000) {
        score.mcScore = 6;
    } else if (mc <= 150000) {
        score.mcScore = 3;
    } else if (mc <= 300000) {
        score.mcScore = 1;
    } else {
        score.mcScore = 0;
    }

    // 2. LIQUIDITY SCORE (8 pts max)
    // v6: Oran %15-50 + $15k+=8, Oran %10-50 + $10k+=6, Oran %5-70 + $5k+=3
    const liqRatio = mc > 0 ? (liq / mc) : 0;
    const liqRatioPct = liqRatio * 100;

    if (liqRatioPct >= 15 && liqRatioPct <= 50 && liq >= 15000) {
        score.liquidityScore = 8;
    } else if (liqRatioPct >= 10 && liqRatioPct <= 50 && liq >= 10000) {
        score.liquidityScore = 6;
    } else if (liqRatioPct >= 5 && liqRatioPct <= 70 && liq >= 5000) {
        score.liquidityScore = 3;
    }

    // 3. HOLDER DISTRIBUTION SCORE (10 pts max)
    // v6: Top1<%8+Top10<%25=10, Top1<%12+Top10<%35=7, Top1<%15+Top10<%45=4, Top1<%20+Top10<%50=2
    if (top1Pct < 8 && top10Pct < 25) {
        score.distributionScore = 10;
    } else if (top1Pct < 12 && top10Pct < 35) {
        score.distributionScore = 7;
    } else if (top1Pct < 15 && top10Pct < 45) {
        score.distributionScore = 4;
    } else if (top1Pct < 20 && top10Pct < 50) {
        score.distributionScore = 2;
    }

    // 4. SECURITY SCORE (6 pts max)
    // v6: LP Burned/Locked %90+=3, CG+CMC Listed=3, tek=2
    let securityPoints = 0;

    // LP Security: Burned or Locked >= 90%
    if (lpBurned || lpLocked >= 90) {
        securityPoints += 3;
    }

    // Listing status (mock - would need CoinGecko/CoinMarketCap API)
    // For Base, we can check if has dexScreener link as a basic check
    if (token.links?.dexScreener) {
        securityPoints += 2; // Has dexScreener listing
    }

    // If only one of the above, add 1 more point for partial security
    if (securityPoints > 0 && securityPoints < 3) {
        securityPoints += 1;
    }

    score.securityScore = Math.min(6, securityPoints);

    // 5. AGE SCORE (6 pts max)
    // v6: 21-45dk=6, 45-120dk=4, 120-360dk=3, 360-1440dk=1
    if (ageMins >= 21 && ageMins <= 45) {
        score.ageScore = 6;
    } else if (ageMins > 45 && ageMins <= 120) {
        score.ageScore = 4;
    } else if (ageMins > 120 && ageMins <= 360) {
        score.ageScore = 3;
    } else if (ageMins > 360 && ageMins <= 1440) {
        score.ageScore = 1;
    }

    // TOTAL (Capped at 40 per v6)
    score.total = score.mcScore + score.liquidityScore + score.distributionScore + score.securityScore + score.ageScore;
    score.total = Math.max(0, Math.min(40, score.total));

    return score;
}
