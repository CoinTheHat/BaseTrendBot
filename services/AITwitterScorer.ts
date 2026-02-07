import { TokenSnapshot } from '../models/types';
import { LLMService } from './LLMService';
import { logger } from '../utils/Logger';

export interface AIScore {
    securityScore: number;    // 15 pts max
    vibeScore: number;        // 20 pts max
    narrativeScore: number;   // 10 pts max
    influencerScore: number;  // 5 pts max
    total: number;
    verdict: string;
    details?: any;
}

/**
 * PHASE 3: AI TWITTER SCORING (50 Pts Max)
 * Evaluates the social sentiment, community quality, and influencer presence.
 */
export class AITwitterScorer {
    constructor(private llmService: LLMService) { }

    async calculateAIScore(token: TokenSnapshot, tweets: string[]): Promise<AIScore> {
        let score: AIScore = {
            securityScore: 0,
            vibeScore: 0,
            narrativeScore: 0,
            influencerScore: 0,
            total: 0,
            verdict: ""
        };

        // A) SECURITY (15 pts max)
        if ((token.holderCount || 0) >= 150) score.securityScore += 5;

        // top10HoldersSupply < 35 bonus
        if ((token.top10HoldersSupply || 0) < 35) score.securityScore += 5;

        const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;
        if (ageMins >= 20 && ageMins <= 240) score.securityScore += 5;

        // 2. SOCIAL ANALYSIS
        if (tweets.length === 0) {
            score.total = 0;
            score.verdict = "NO_TWITTER";
            return score;
        }

        const aiAnalysis = await this.llmService.analyzeSocialV3(token, tweets);
        if (!aiAnalysis) {
            logger.warn(`[AITwitterScorer] LLM analysis failed for ${token.symbol}. Fallback to base security score.`);
            score.total = score.securityScore;
            score.verdict = "AI_FAILED";
            return score;
        }

        score.details = aiAnalysis;

        // B) VIBE (20 pts max)
        let vibeRaw = 0;
        const tags = aiAnalysis.tags || [];

        // Pozitif etiketler
        if (tags.includes("[TECH_ART]")) vibeRaw += 8;
        if (tags.includes("[ORIGINAL_MEME]")) vibeRaw += 6;
        if (tags.includes("[SMART_MONEY]")) vibeRaw += 6;

        // Negatif etiketler
        if (tags.includes("[ALPHA_GROUP]")) vibeRaw -= 5;
        if (tags.includes("[PUMP_KEYWORD]")) vibeRaw -= 5;
        if (tags.includes("[HYPE_SPAM]")) vibeRaw -= 10;

        // Sentiment bonus
        if (aiAnalysis.sentiment > 70) vibeRaw += 5;
        else if (aiAnalysis.sentiment >= 50) vibeRaw += 2;

        // Vibe max 20, min 0
        score.vibeScore = Math.max(0, Math.min(20, vibeRaw));

        // C) NARRATIVE (10 pts max)
        if (aiAnalysis.narrativeStrength === "strong") score.narrativeScore = 10;
        else if (aiAnalysis.narrativeStrength === "medium") score.narrativeScore = 5;

        // D) INFLUENCER (5 pts max)
        if (aiAnalysis.influencerCount >= 3) score.influencerScore = 5;
        else if (aiAnalysis.influencerCount >= 1) score.influencerScore = 3;

        // TOTAL (Maximum 50)
        // Note: The user logic says "score = 15 + vibeScore" for the vibe part, 
        // but it actually seems to be: security(15) + vibe(20) + narrative(10) + influencer(5) = 50.
        score.total = score.securityScore + score.vibeScore + score.narrativeScore + score.influencerScore;
        score.total = Math.max(0, Math.min(50, score.total));

        // VERDICT
        if (score.total >= 40) score.verdict = "STRONG_SOCIAL";
        else if (score.total >= 25) score.verdict = "MODERATE_SOCIAL";
        else score.verdict = "WEAK_SOCIAL";

        return score;
    }
}
