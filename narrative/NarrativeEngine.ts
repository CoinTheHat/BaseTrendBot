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

        // PREPEND CA (User Request)
        const caLine = `📋 CA: \`${token.mint}\`\n\n`;

        // 1. Narrative Context (Clean & Professional)
        let intro = `**${memeName}** is gaining traction.`;
        if (match.matchedMeme?.tags?.includes('ALPHA')) {
            intro = `🔥 High Momentum detected for **$${symbol}**.`;
        } else if (match.matchedMeme?.phrase === token.mint) {
            intro = `💎 **$${symbol}** matched via Watchlist.`;
        }

        let narrativeText = ""; // Will build this up
        let vibeCheck = "Analyzing...";
        let aiRisk = "";
        let finalAiScore: number | undefined = undefined;
        let finalAiReason: string | undefined = undefined;

        // 3. Data Section
        const twitterStatus = recentTweets.length > 0 ? `✅ Twitter Data: ${recentTweets.length} tweets` : '⚠️ Twitter Data: None';
        const dataSection =
            `• MC: $${(token.marketCapUsd || 0).toLocaleString()}\n` +
            `• Liq: $${(token.liquidityUsd ?? 0).toLocaleString()}\n` +
            `• Vol (5m): $${(token.volume5mUsd ?? 0).toLocaleString()}\n` +
            `• Buyers (5m): ${token.buyers5m ?? 'Veri Alınamadı'}\n` +
            `• ${twitterStatus}`;

        // PRE-FILTERING (User Request)
        const isLowLiquidity = (token.liquidityUsd || 0) < 5000;
        const hasNoTweets = recentTweets.length === 0;

        // EXCEPTION: If Liquidity > $20k, force AI even if no tweets (Technical Analysis)
        const isHighLiqTrace = (token.liquidityUsd || 0) > 20000;

        const shouldSkipAI = isLowLiquidity || (hasNoTweets && !isHighLiqTrace);

        if (shouldSkipAI) {
            // SKIP AI
            intro = `⚠️ **Early Stage / High Risk** ($${symbol})`;
            narrativeText = `${caLine}${intro}\n\n`;
            narrativeText += `⚠️ **AI Analizi Atlandı:**\n`;
            if (isLowLiquidity) narrativeText += `• Likidite çok düşük (<$5k).\n`;
            if (hasNoTweets) narrativeText += `• Twitter verisi bulunamadı ve Likidite eşik altı (<$20k).\n`;

            narrativeText += `\n🚫 **Karar:** UZAK DUR (Otomatik)`;
            finalAiScore = 2; // Low score
            finalAiReason = isLowLiquidity ? "Low Liquidity" : "No Socials & Low Liq";
            vibeCheck = "Ghost Town 👻";

        } else {
            // RUN AI
            let aiResult = await this.llm.analyzeToken(symbol, recentTweets, dataSection);

            if (aiResult) {
                // AI Override: Use AI's headline if provided, else keep intro
                let header = intro;
                if (aiResult.headline) {
                    header = `**${aiResult.headline}**`;
                }

                // Assemble Text
                narrativeText = `${caLine}${header}\n${aiResult.narrative}\n`;
                narrativeText += `\n💡 **Neden Yükseliyor?**\n• ${aiResult.analysis.join('\n• ')}\n`;

                // Vibe
                const vibe = aiResult.vibe || 'Analiz yapılıyor...';
                vibeCheck = `${aiResult.displayEmoji} ${vibe}`;

                // Risk Analysis
                if (aiResult.riskLevel === 'HIGH' || aiResult.riskLevel === 'DANGEROUS') {
                    aiRisk = `\n⚠️ **RİSK FAKTÖRLERİ:**\n${aiResult.riskReason}`;
                } else {
                    aiRisk = `\n✅ **Risk Durumu:** ${aiResult.riskReason || 'Temiz görünüyor.'}`;
                }

                // Turkish Recommendation
                const recommendation = aiResult.recommendation || 'DİKKATLİ İZLE';
                const advice = aiResult.advice || '';
                finalAiScore = aiResult.score;
                finalAiReason = aiResult.riskReason;

                let recEmoji = '⚠️';
                if (finalAiScore >= 8) recEmoji = '🚀';
                else if (finalAiScore >= 5) recEmoji = '⚠️';
                else recEmoji = '🚫';

                narrativeText += `\n🎯 **AI PUANI:** ${finalAiScore}/10\n`;
                narrativeText += `${recEmoji} **Karar:** ${recommendation}`;
                if (advice) narrativeText += `\n💬 **AI Tavsiyesi:** ${advice}`;
            } else {
                // AI Failed
                narrativeText = `${caLine}${intro}\n\n⚠️ AI Analizi başarısız oldu (Servis yok).`;
            }
        }

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
            dataSection: dataSection.replace('N/A', 'Veri Alınamadı'), // Quick fix for text processing if needed, but better to handle upstream
            tradeLens,
            vibeCheck,
            aiScore: finalAiScore,
            aiReason: finalAiReason
        };
    }
}
