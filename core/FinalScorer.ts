import { TokenSnapshot } from '../models/types';
import { TechnicalScore } from './TechnicalScorer';
import { AIScore } from '../services/AITwitterScorer';
import { detectFakePump } from './FakePumpDetector';

export interface FinalScore {
    technicalScore: number; // 0-50
    aiScore: number;        // 0-50
    bonuses: number;
    penalties: number;
    finalScore: number;     // 0-100
    verdict: string;
    category: 'EARLY APE' | 'VERIFIED GEM' | 'FADE';
}

/**
 * PHASE 4: FINAL SCORING
 * Combines all individual scores, bonuses, and penalties into a single metric.
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

    // 1. BONUSES
    if (maturationData.viralBonus) final.bonuses += 5; // Master Logic: +5 for 30%+ growth
    if (maturationData.viralMultiplier >= 1.2) final.bonuses += 10;

    // 2. PENALTIES
    // Twitter absence penalty
    if (aiScore.verdict === "NO_TWITTER") {
        final.penalties += 10;
    }

    // Top Holder Risk (Already handled in TechnicalScore points, but we can add a penalty for "Risky but not rejected" zone)
    const top10Pct = token.top10HoldersSupply || 0;
    if (top10Pct >= 35 && top10Pct < 50) {
        final.penalties += 5;
    }

    // 3. FINAL CALCULATION (50/50 Split)
    // Both technicalScore and aiScore are 0-50 max.
    final.finalScore = (final.technicalScore + final.aiScore) + final.bonuses - final.penalties;
    final.finalScore = Math.max(0, Math.min(100, final.finalScore));

    // 4. CATEGORIZATION & VERDICT
    if (ageMins >= 20 && ageMins < 45) {
        final.category = 'EARLY APE';

        // EARLY APE SPECIFIC RULES: Strict AI Requirement
        const hasTwitter = !!token.links.twitter;
        const aiScoreZero = final.aiScore === 0;

        if (hasTwitter && aiScoreZero) {
            final.verdict = "❌ FADE (AI Required)";
            final.category = 'FADE';
            final.finalScore = 0; // Force rejection
        } else if (final.finalScore >= 65) {
            final.verdict = "🔥 EARLY APE ⚠️ High Risk";
        } else {
            final.verdict = "❌ FADE";
            final.category = 'FADE';
        }
    } else {
        final.category = 'VERIFIED GEM';
        if (final.finalScore >= 85) {
            final.verdict = "💎 VERIFIED GEM";
        } else if (final.finalScore >= 65) {
            final.verdict = "✅ APE CANDIDATE";
        } else if (final.finalScore >= 50) {
            final.verdict = "⚠️ WATCH";
        } else {
            final.verdict = "❌ FADE";
            final.category = 'FADE';
        }
    }

    return final;
}
