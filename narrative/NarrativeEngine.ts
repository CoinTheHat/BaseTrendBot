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

        // 1. Narrative Context (Default / Fallback)
        let intro = `The '${memeName}' meme is trending off-chain.`;
        if (match.matchedMeme?.tags?.includes('ALPHA')) {
            intro = `High momentum detected for **$${symbol}**.`;
        } else if (match.matchedMeme?.phrase === token.mint) {
            intro = `**$${symbol}** detected via Watchlist (Specific CA match).`;
        }

        let narrativeText = `${intro} First Solana token aligned with this vibe just spawned: **$${symbol}**.\n\n` +
            `Alien sensors detected specific high-frequency alignment with human distress signals around this meme.`;

        let vibeCheck = "Vibe matches galactic patterns. Monitor closely.";
        let aiRisk = "";

        // 2. AI Analysis (Override if available)
        if (recentTweets.length > 0) {
            const aiResult = await this.llm.analyzeToken(symbol, recentTweets);

            if (aiResult) {
                narrativeText = `🧠 **AI Analizi:**\n${aiResult.narrative}`;
                vibeCheck = `${aiResult.displayEmoji} Score: ${aiResult.vibeScore}/100`;

                if (aiResult.riskLevel === 'HIGH' || aiResult.riskLevel === 'DANGEROUS') {
                    aiRisk = `\n\n⛔ **RISK UYARISI:** ${aiResult.riskReason}`;
                }
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
            tradeLens = `Phase: SPOTTED 🛸 → Early discovery. Risk is max.`;
        } else if (score.phase === 'TRACKING') {
            tradeLens = `Phase: TRACKING 📡 → Volume building.`;
        } else if (score.phase === 'COOKING') {
            tradeLens = `Phase: COOKING 🔥 → Momentum high.`;
        } else {
            tradeLens = `Phase: SERVED 🍽 → Verify distribution.`;
        }

        return {
            narrativeText,
            dataSection,
            tradeLens,
            vibeCheck
        };
    }
}
