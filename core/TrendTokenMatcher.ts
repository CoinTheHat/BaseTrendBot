import { TrendItem, TokenSnapshot, TrendTokenMatch } from '../models/types';
import { ScoringEngine } from './ScoringEngine';

import { logger } from '../utils/Logger';

export class TrendTokenMatcher {
    constructor(private scorer: ScoringEngine) { }

    matchTrends(trends: TrendItem[], tokens: TokenSnapshot[]): TrendTokenMatch[] {
        logger.info(`[TrendMatcher] Matching ${trends.length} trends against ${tokens.length} tokens...`);
        const results: TrendTokenMatch[] = [];

        for (const trend of trends) {
            // 1. Keyword extraction
            // "sad penguin" -> ["sad", "penguin"]
            const keywords = this.extractKeywords(trend.phrase);
            if (keywords.length === 0) continue;

            const matchedTokens: { snapshot: TokenSnapshot; score: number; phase?: string }[] = [];

            for (const token of tokens) {
                if (this.isMatch(token, keywords)) {
                    // Calculate score reusing engine (but without meme bonus? or treat trend as meme match)
                    // We pass memeMatch=true effectively since it matched a trend
                    const scoreRes = this.scorer.score(token, { memeMatch: true, matchedMeme: { id: trend.id, phrase: trend.phrase, tags: [], createdAt: new Date() } });

                    if (scoreRes.totalScore >= 5) { // Min threshold for suggestion
                        matchedTokens.push({
                            snapshot: token,
                            score: scoreRes.totalScore,
                            phase: scoreRes.phase
                        });
                    }
                }
            }

            if (matchedTokens.length > 0) {
                // Sort by score
                matchedTokens.sort((a, b) => b.score - a.score);
                results.push({
                    trend,
                    tokens: matchedTokens
                });
            } else {
                // Keep empty match if we want to show "Social Trend (No Token)"?
                // User asked: "If no token matches... explicitly say: No clear token yet"
                results.push({ trend, tokens: [] });
            }
        }

        return results;
    }

    private extractKeywords(phrase: string): string[] {
        const stops = ['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'with', 'by'];
        return phrase.toLowerCase().split(' ')
            .map(w => w.replace(/[^a-z0-9]/g, '')) // clear punctuation, hashtags, cash tags
            .filter(w => w.length >= 3 && !stops.includes(w)); // Min length 3 to avoid "is", "it"
    }

    private isMatch(token: TokenSnapshot, keywords: string[]): boolean {
        // Normalize Token: Remove $, -
        const name = token.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
        const sym = token.symbol.toLowerCase().replace(/[^a-z0-9]/g, '');

        // 1. Exact Symbol Match (Strongest)
        // Trend "Elon" matches $ELON
        if (keywords.some(k => sym === k)) return true;

        // 2. Exact Name Word Match
        // Trend "Chill" matches "Chill Guy"
        const nameWords = name.split(/\s+/);
        if (keywords.some(k => nameWords.includes(k))) return true;

        // 3. Substring (Weak) - Only for longer keywords to avoid "cat" matching "catch"
        // Trend "Bitcoin" matches "BitcoinETF"
        return keywords.some(k => k.length > 4 && (name.includes(k) || sym.includes(k)));
    }
}
