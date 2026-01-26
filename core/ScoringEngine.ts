import { TokenSnapshot, MemeMatchResult, ScoreResult, ScoreBreakdown } from '../models/types';
import { config } from '../config/env';

export class ScoringEngine {

    score(token: TokenSnapshot, matchResult: MemeMatchResult): ScoreResult {
        let totalScore = 0;
        const breakdown: ScoreBreakdown[] = [];

        // 1. Meme Match (VIP Pass)
        if (matchResult.memeMatch) {
            totalScore += 10; // Massive boost to ensure alert
            breakdown.push({ factor: 'Meme Match', points: 10, details: `Matches '${matchResult.matchedMeme?.phrase}'` });
        }

        // 2. Market Cap
        const mc = token.marketCapUsd || 0;
        if (mc >= config.MIN_MC_USD && mc <= config.MAX_MC_USD) {
            totalScore += 2;
            breakdown.push({ factor: 'MC Range', points: 2, details: `MC $${(mc / 1000).toFixed(1)}k in sweet spot` });
        } else if (mc < config.MIN_MC_USD / 2) {
            // 0 points, too early
            breakdown.push({ factor: 'MC Range', points: 0, details: `MC $${(mc / 1000).toFixed(1)}k too low` });
        } else if (mc > config.MAX_MC_USD * 2) {
            // Only penalize if NOT a specific match
            if (!matchResult.memeMatch) {
                totalScore -= 2;
                breakdown.push({ factor: 'MC Range', points: -2, details: `MC $${(mc / 1000).toFixed(1)}k too high` });
            } else {
                breakdown.push({ factor: 'MC Range', points: 0, details: `MC High but Ignored (Matched)` });
            }
        }

        // 3. Liquidity
        const liq = token.liquidityUsd || 0;
        if (liq >= config.MIN_LIQUIDITY_USD) {
            totalScore += 2;
            breakdown.push({ factor: 'Liquidity', points: 2, details: `Liq $${(liq / 1000).toFixed(1)}k healthy` });
        } else {
            totalScore -= 2;
            breakdown.push({ factor: 'Liquidity', points: -2, details: `Liq $${(liq / 1000).toFixed(1)}k low` });
        }

        // 4. Volume & Momentum
        const vol5 = token.volume5mUsd || 0;
        const vol30 = token.volume30mUsd || 0;

        // Check minimal volume activity (arbitrary threshold relative to liquidity)
        if (vol5 >= 1000) { // e.g. $1k in 5 mins
            totalScore += 2;
            breakdown.push({ factor: 'Volume', points: 2, details: `$${(vol5 / 1000).toFixed(1)}k / 5m` });
        }

        // Momentum
        if (vol30 > 0 && vol5 > (vol30 / 6) * 2) {
            // simple logic: if 5m vol is significantly higher than average 5m chunk of 30m vol
            // logic in prompt: vol5m > vol30m / 2 (which implies huge spike)
            if (vol5 > vol30 / 2) {
                totalScore += 1;
                breakdown.push({ factor: 'Momentum', points: 1, details: 'Strong 5m volume spike' });
            }
        }

        // 5. Buyers (if available)
        // token.buyers5m not always set, skip for V1 heuristic if undefined

        return {
            totalScore,
            breakdown,
            phase: 'SPOTTED' // Default, will be recalculated by PhaseDetector
        };
    }
}
