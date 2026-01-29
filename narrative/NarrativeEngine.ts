import { TokenSnapshot, MemeWatchItem, ScoreResult, Narrative } from '../models/types';
import { MemeMatchResult } from '../models/types';
import { LLMService } from '../services/LLMService';

export class NarrativeEngine {

    constructor(private llm: LLMService) { }

    async generate(token: TokenSnapshot, match: MemeMatchResult, score: ScoreResult, recentTweets: string[] = []): Promise<Narrative> {
        let memeName = match.matchedMeme ? match.matchedMeme.phrase : 'unknown';
        const symbol = token.symbol;

        // Visual Fit: If memeName is a CA (long), use Token Name instead
        if (memeName.length > 15 && !memeName.includes(' ')) {
            memeName = `${token.name} (${symbol})`;
        }

        // 1. Narrative Context (Clean & Professional)
        let intro = `**${memeName}** is gaining traction.`;
        if (match.matchedMeme?.tags?.includes('ALPHA')) {
            intro = `🔥 High Momentum detected for **$${symbol}**.`;
        } else if (match.matchedMeme?.phrase === token.mint) {
            intro = `💎 **$${symbol}** matched via Watchlist.`;
        }

        let narrativeText = `${intro}\n`;
        let vibeCheck = "Analyzing...";
        let aiRisk = "";

        // 2. AI Analysis (Override if available)
        if (recentTweets.length > 0) {
            const aiResult = await this.llm.analyzeToken(symbol, recentTweets);

            if (aiResult) {
                // AI Override: Use AI's headline if provided, else keep intro
                if (aiResult.headline) {
                    narrativeText = `**${aiResult.headline}**\n${intro}\n`;
                }

                narrativeText += `\n💡 **Neden Yükseliyor?**\n• ${aiResult.analysis.join('\n• ')}\n`;

                vibeCheck = `${aiResult.displayEmoji} Score: ${aiResult.score}/10`;

                // Risk Analysis
                if (aiResult.riskLevel === 'HIGH' || aiResult.riskLevel === 'DANGEROUS') {
                    aiRisk = `\n⚠️ **RİSK FAKTÖRLERİ:**\n${aiResult.riskReason}`;
                } else {
                    aiRisk = `\n✅ **Risk Durumu:** ${aiResult.riskReason || 'Temiz görünüyor.'}`;
                }

                // Verdict Tag
                narrativeText += `\n🎯 **Karar:** #${aiResult.verdict}`;
            }
        }

        if (aiRisk) narrativeText += aiRisk;


        // 3. Data Section
        const dataSection =
            `• MC: $${(token.marketCapUsd || 0).toLocaleString()}\n` +
            `• Liq: $${(token.liquidityUsd ?? 0).toLocaleString()}\n` +
            `• Vol (5m): $${(token.volume5mUsd ?? 0).toLocaleString()}\n` +
            `• Buyers (5m): ${token.buyers5m ?? 'N/A'}`;

        // 4. Trade Lens
        let tradeLens = '';
        if (score.phase === 'SPOTTED') {
            tradeLens = `Stage: **SPOTTED** (Early)`;
        } else if (score.phase === 'TRACKING') {
            tradeLens = `Stage: **TRACKING** (Volume Building)`;
        } else if (score.phase === 'COOKING') {
            tradeLens = `Stage: **COOKING** 🔥 (Momentum)`;
        } else {
            tradeLens = `Stage: **SERVED** 🚀 (Confirmed)`;
        }

        return {
            narrativeText,
            dataSection,
            tradeLens,
            vibeCheck
        };
    }
}
