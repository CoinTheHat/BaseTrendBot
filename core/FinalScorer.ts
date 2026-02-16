import { TokenSnapshot } from '../models/types';
import { TechnicalScore } from './TechnicalScorer';
import { AIScore } from '../services/AITwitterScorer';
import { detectFakePump } from './FakePumpDetector';

export interface FinalScore {
    technicalScore: number; // 0-40
    aiScore: number;         // 0-60
    bonuses: number;
    penalties: number;
    finalScore: number;      // 0-100
    verdict: string;
    category: 'APE CANDIDATE' | 'EARLY SIGNAL' | 'FADE';
}

/**
 * PHASE 4: FINAL SCORING v6
 * Base Chain adapted from Solana v6 system
 * 
 * Breakdown:
 * - Technical: 40 pts max
 * - AI/Social: 60 pts max
 * - Total: 100 pts max
 * 
 * Alert Tiers (v6):
 * - 58+ → 🔥 APE CANDIDATE (MC ≤ $150k)
 * - 50-57 → 👀 EARLY SIGNAL (MC ≤ $100k)
 * - <50 → ❌ FADE
 */
export function calculateFinalScore(
    token: TokenSnapshot,
    techScore: TechnicalScore,
    aiScore: AIScore,
    maturationData: { viralBonus: boolean, viralMultiplier: number }
): FinalScore {
    let final: FinalScore = {
        technicalScore: techScore.total,
        aiScore: aiScore.total,
        bonuses: 0,
        penalties: 0,
        finalScore: 0,
        verdict: "",
        category: 'FADE'
    };

    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;
    const mc = token.marketCapUsd || 0;

    // 1. BONUSES
    // v6: Viral bonus for strong growth
    if (maturationData.viralBonus) final.bonuses += 3; // Reduced from 5
    if (maturationData.viralMultiplier >= 1.2) final.bonuses += 5;

    // 2. PENALTIES
    // Twitter absence penalty
    if (aiScore.verdict === "NO_TWITTER" || aiScore.verdict === "AI_GATE_FAILED") {
        final.penalties += 10;
    }

    // Top Holder Risk (Already handled in TechnicalScore points, but we can add a penalty for "Risky but not rejected" zone)
    const top10Pct = token.top10HoldersSupply || 0;
    if (top10Pct >= 40 && top10Pct < 50) {
        final.penalties += 3;
    }

    // 3. FINAL CALCULATION
    // v6: Technical (40 max) + AI (60 max)
    final.finalScore = (final.technicalScore + final.aiScore) + final.bonuses - final.penalties;
    final.finalScore = Math.max(0, Math.min(100, final.finalScore));

    // 4. CATEGORIZATION & VERDICT v6
    // Check MC thresholds for alert tiers
    const mcOkForApe = mc <= 150000;
    const mcOkForSignal = mc <= 100000;

    // AI Gate Check (from AI Scorer)
    if (aiScore.verdict === "AI_GATE_FAILED") {
        final.verdict = "❌ FADE (AI Gate Failed)";
        final.category = 'FADE';
        final.finalScore = Math.min(final.finalScore, 45); // Cap score
        return final;
    }

    // v6 Alert Tiers
    if (final.finalScore >= 58 && mcOkForApe) {
        final.category = 'APE CANDIDATE';
        final.verdict = "🔥 APE CANDIDATE";
    } else if (final.finalScore >= 50 && mcOkForSignal) {
        final.category = 'EARLY SIGNAL';
        final.verdict = "👀 EARLY SIGNAL";
    } else {
        final.category = 'FADE';
        final.verdict = "❌ FADE";
    }

    // Special case: Early stage tokens need stronger AI signal
    if (ageMins >= 20 && ageMins <= 60) {
        // For very new tokens, require decent AI score
        if (aiScore.total < 15) {
            final.category = 'FADE';
            final.verdict = "❌ FADE (Too New)";
            final.finalScore = Math.min(final.finalScore, 45);
        }
    }

    return final;
}
