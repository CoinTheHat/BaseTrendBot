import { TokenSnapshot } from '../models/types';
import { LLMService } from './LLMService';
import { logger } from '../utils/Logger';

export interface AIScore {
    organicRateScore: number;     // 5 pts max
    authorDiversityScore: number; // 5 pts max
    narrativeScore: number;        // 25 pts max (5x multiplier)
    communityScore: number;       // 25 pts max (5x multiplier)
    rugRiskPenalty: number;        // -5 pts max penalty
    total: number;
    verdict: string;
    details?: {
        tags: string[];
        sentiment: number;
        narrativeStrength: 'strong' | 'medium' | 'weak';
        influencerCount: number;
        riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
        summary: string;
    };
}

/**
 * PHASE 3: AI TWITTER SCORING v6 (60 Pts Max)
 * Base Chain adapted from Solana v6 system
 * 
 * Breakdown:
 * - Programmatic (10p): Organic Rate (5p) + Author Diversity (5p)
 * - AI Deep (50p): Narrative × 5 (25p) + Community × 5 (25p) - Rug Risk × 1 (-5p max)
 * 
 * Gate: narrative + community < 2 → REJECT (retry 30m)
 */
export class AITwitterScorer {
    constructor(private llmService: LLMService) { }

    async calculateAIScore(token: TokenSnapshot, tweets: string[]): Promise<AIScore> {
        let score: AIScore = {
            organicRateScore: 0,
            authorDiversityScore: 0,
            narrativeScore: 0,
            communityScore: 0,
            rugRiskPenalty: 0,
            total: 0,
            verdict: ""
        };

        // Early rejection if no tweets and token is not established
        const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;

        if (tweets.length === 0) {
            // If no Twitter but token is very new (< 30 mins), allow with low score
            // Otherwise reject
            if (ageMins < 30) {
                // Allow early tokens without Twitter but with low score
                score.total = 5;
                score.verdict = "NO_TWITTER_EARLY";
            } else {
                score.total = 0;
                score.verdict = "NO_TWITTER";
            }
            return score;
        }

        // 1. PROGRAMMATIC SCORING (10 pts max)
        // Calculate based on tweets
        const tweetAnalysis = this.analyzeTweetsProgrammatically(tweets);
        score.organicRateScore = tweetAnalysis.organicRateScore;
        score.authorDiversityScore = tweetAnalysis.authorDiversityScore;

        // 2. AI DEEP SCORING (50 pts max)
        const aiAnalysis = await this.llmService.analyzeSocialV3(token, tweets);
        if (!aiAnalysis) {
            logger.warn(`[AITwitterScorer] LLM analysis failed for ${token.symbol}. Fallback to programmatic score.`);
            score.total = score.organicRateScore + score.authorDiversityScore;
            score.verdict = "AI_FAILED";
            return score;
        }

        score.details = aiAnalysis;

        // Narrative: 0-5 scale mapped to 0-25 pts
        // v6: narrative × 5
        const narrativeMap: Record<string, number> = {
            'strong': 5,
            'medium': 3,
            'weak': 1,
            'none': 0
        };
        const narrativeRaw = narrativeMap[aiAnalysis.narrativeStrength] || 0;
        score.narrativeScore = narrativeRaw * 5;

        // Community: Based on sentiment and tags, 0-5 scale mapped to 0-25 pts
        // v6: community × 5
        let communityRaw = 0;
        const tags = aiAnalysis.tags || [];

        // Positive community signals
        if (tags.includes("[TECH_ART]") || tags.includes("[ORIGINAL_MEME]") || tags.includes("[SMART_MONEY]")) {
            communityRaw += 2;
        }
        if (tags.includes("[REAL_QUESTIONS]")) {
            communityRaw += 1;
        }
        // Negative community signals
        if (tags.includes("[ALPHA_GROUP]") || tags.includes("[PUMP_KEYWORD]") || tags.includes("[HYPE_SPAM]")) {
            communityRaw -= 1;
        }

        // Sentiment bonus (0-100 -> 0-2)
        if (aiAnalysis.sentiment >= 70) communityRaw += 2;
        else if (aiAnalysis.sentiment >= 50) communityRaw += 1;

        // Influencer bonus (0-10 -> 0-2)
        if (aiAnalysis.influencerCount >= 3) communityRaw += 2;
        else if (aiAnalysis.influencerCount >= 1) communityRaw += 1;

        // Clamp community to 0-5
        communityRaw = Math.max(0, Math.min(5, communityRaw));
        score.communityScore = communityRaw * 5;

        // Rug Risk Penalty: -5 pts max
        // Based on risk level from AI analysis
        const riskPenaltyMap: Record<string, number> = {
            'DANGEROUS': -5,
            'HIGH': -3,
            'MEDIUM': -1,
            'LOW': 0
        };
        score.rugRiskPenalty = riskPenaltyMap[aiAnalysis.riskLevel] || 0;

        // AI MIN GATE CHECK
        // narrative + community < 2 → REJECT
        if (narrativeRaw + communityRaw < 2) {
            logger.info(`[AI Gate] ❌ REJECTED: ${token.symbol} | Narrative: ${narrativeRaw}, Community: ${communityRaw} (Threshold: 2)`);
            score.total = 0;
            score.verdict = "AI_GATE_FAILED";
            return score;
        }

        // TOTAL (Maximum 60)
        score.total = score.organicRateScore + score.authorDiversityScore +
            score.narrativeScore + score.communityScore + score.rugRiskPenalty;
        score.total = Math.max(0, Math.min(60, score.total));

        // VERDICT
        if (score.total >= 45) score.verdict = "STRONG_SOCIAL";
        else if (score.total >= 25) score.verdict = "MODERATE_SOCIAL";
        else if (score.total >= 10) score.verdict = "WEAK_SOCIAL";
        else score.verdict = "POOR_SOCIAL";

        return score;
    }

    /**
     * Programmatic analysis of tweets (no LLM needed)
     * Returns Organic Rate (5p max) and Author Diversity (5p max)
     */
    private analyzeTweetsProgrammatically(tweets: string[]): { organicRateScore: number; authorDiversityScore: number } {
        let organicCount = 0;
        const uniqueAuthors = new Set<string>();

        for (const tweet of tweets) {
            // Simple heuristic: Check for signs of bot/spam
            const isBot = this.isLikelyBot(tweet);
            if (!isBot) {
                organicCount++;
            }

            // Extract potential author (simplified - would need full tweet object)
            // For now, use hash of tweet as pseudo-author
            uniqueAuthors.add(this.hashString(tweet));
        }

        // Organic Rate: % of non-bot tweets (5p max)
        const organicRate = tweets.length > 0 ? organicCount / tweets.length : 0;
        let organicRateScore = 0;
        if (organicRate >= 0.8) organicRateScore = 5;
        else if (organicRate >= 0.6) organicRateScore = 4;
        else if (organicRate >= 0.4) organicRateScore = 3;
        else if (organicRate >= 0.2) organicRateScore = 2;
        else if (organicRate > 0) organicRateScore = 1;

        // Author Diversity: How many unique authors (5p max)
        // Normalize: 1 author = 0, 5+ authors = 5
        const uniqueCount = uniqueAuthors.size;
        let authorDiversityScore = 0;
        if (uniqueCount >= 10) authorDiversityScore = 5;
        else if (uniqueCount >= 7) authorDiversityScore = 4;
        else if (uniqueCount >= 5) authorDiversityScore = 3;
        else if (uniqueCount >= 3) authorDiversityScore = 2;
        else if (uniqueCount >= 2) authorDiversityScore = 1;

        return { organicRateScore, authorDiversityScore };
    }

    /**
     * Simple heuristic to detect bot tweets
     */
    private isLikelyBot(tweet: string): boolean {
        const lower = tweet.toLowerCase();

        // Bot patterns
        const botPatterns = [
            /^\s*$/,  // Empty
            /^[\d\W]+$/,  // Only numbers and symbols
            /(.)\1{5,}/,  // Repeated characters (e.g., "LOOOOL")
            /http[s]?:\/\/[^\s]+$/m,  // Only URL (link dump)
            /(diamond|hand|gem|moon|rocket|lfg|to the moon|pump|raid|shill){3,}/i,  // Spam keywords
        ];

        for (const pattern of botPatterns) {
            if (pattern.test(tweet)) return true;
        }

        // Very short tweets with only emojis
        if (tweet.length < 10 && /^[\p{Emoji}\s]+$/u.test(tweet)) return true;

        return false;
    }

    /**
     * Simple hash for pseudo-author identification
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }
}
