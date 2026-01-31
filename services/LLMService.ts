import OpenAI from "openai";
import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { TokenSnapshot } from '../models/types';


export interface AIAnalysisResult {
    headline: string;
    narrative: string;
    analystSummary: string;
    technicalOutlook: string;
    socialVibe: string;
    riskAnalysis: string;
    strategy: string;
    analysis: string[];
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
    riskReason: string;
    score: number; // 0-10
    verdict: 'APE' | 'WATCH' | 'FADE';
    displayEmoji: string;
    recommendation?: string;
    advice?: string;
    vibe?: string;
}

export class LLMService {
    private xai: OpenAI;

    constructor() {
        if (!config.XAI_API_KEY) {
            logger.error('[LLMService] CRITICAL: XAI_API_KEY is missing! Bot cannot function.');
            process.exit(1);
        }
        this.xai = new OpenAI({
            apiKey: config.XAI_API_KEY,
            baseURL: "https://api.x.ai/v1",
        });
    }

    async analyzeToken(token: TokenSnapshot, tweets: string[]): Promise<AIAnalysisResult | null> {
        const hasTweets = tweets.length > 0;
        const { systemPrompt, userContent } = this.buildPrompt(token, tweets, hasTweets);

        try {
            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.2,
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) throw new Error('Empty response from xAI');
            return this.normalizeResult(JSON.parse(content));

        } catch (error: any) {
            logger.error(`[xAI Grok] Analysis failed for $${token.symbol}: ${error.message}`);
            return null;
        }
    }

    private buildPrompt(token: TokenSnapshot, tweets: string[], hasTweets: boolean): { systemPrompt: string; userContent: string } {
        // SNIPER MATH: Pre-calculate Ratios
        const mc = token.marketCapUsd || 0;
        const liq = token.liquidityUsd || 1;
        const vol = token.volume5mUsd || 0;

        const volLiqRatio = (vol / liq).toFixed(2); // Critical Sniper Metric
        const liqMcRatio = mc > 0 ? (liq / mc).toFixed(4) : "0";

        // GHOST PROTOCOL INSTRUCTION
        const ghostInstruction = !hasTweets
            ? "\n🚨 **GHOST PROTOCOL:** NO TWEETS FOUND. SCORE MUST BE MAX 4. REJECT IMMEDIATELY."
            : "";

        // WOLF SYSTEM PROMPT
        const systemPrompt = `
YOU ARE "THE WOLF" (Crypto Sniper & Narrative Interpreter).
Your job is to find 100x GEMS and ruthlessly filter out TRASH.
You analyze Technical Impulse + Social Quality.

**INPUT DATA CONTEXT:**
- Liquidity: $${liq.toLocaleString()}
- 5m Volume: $${vol.toLocaleString()}
- **Vol/Liq Ratio:** ${volLiqRatio}x (If > 1.5x, this is a BREAKOUT/SNIPER signal).

**INTERPRETATION RULES (QUALITY OVER QUANTITY):**

1. **BOT CHECK (Spam Filter):**
   - Read the tweets. Are they identical "CA: ..." spam?
   - If YES -> **SCORE: 1 (REJECT)**. Do not pass go.

2. **NARRATIVE CHECK:**
   - Is there a specific story? (e.g. "AI Agent", "TikTok Trend", "Founder History").
   - If YES -> **+3 POINTS**.

3. **ORGANIC VIBE:**
   - Do tweets use slang, memes, or show genuine excitement?
   - If YES -> **+2 POINTS**.

**SCORING RUBRIC (STRICT):**
- **1-4 (REJECT):** Bot Spam OR Ghost Protocol OR Low Momentum.
- **5-6 (MID):** Metrics okay but boring community. (User does NOT want these).
- **7-8 (BUY):** Breakout Momentum (>1.5x) + Real Human Tweets.
- **9-10 (GEM):** "God Candle" Metrics + Viral Narrative.

**FINAL DECISION:**
- If Score < 7, Verdict MUST be "FADE".
- If Score >= 7, Verdict MUST be "APE" or "WATCH".

${ghostInstruction}

**JSON OUTPUT FORMAT:**
{
    "headline": "Punchy Headline (e.g. SNIPER ALERT: ORGANIC HYPE)",
    "narrative": "What is the story?",
    "analystSummary": "Ruthless summary of pros/cons.",
    "technicalOutlook": "Comment on Vol/Liq Ratio (${volLiqRatio}x).",
    "socialVibe": "Is it Bots or Humans?",
    "riskAnalysis": "Rug/Dump risks.",
    "strategy": "APE / WATCH / FADE",
    "score": number, 
    "verdict": "APE" | "WATCH" | "FADE",
    "displayEmoji": "💎",
    "recommendation": "BUY / PASS"
}
`;
        const userContent = `
TOKEN: $${token.symbol} (${token.name})
CA: ${token.mint}
Stats: Liq $${liq.toLocaleString()} | MC $${mc.toLocaleString()} | 5m Vol $${vol.toLocaleString()}

TWEETS (${tweets.length}):
${hasTweets ? tweets.slice(0, 30).join('\n') : "NO DATA"}
`;

        return { systemPrompt, userContent };
    }

    private normalizeResult(result: any): AIAnalysisResult {
        return {
            headline: result.headline || `🚨 ANALYZING`,
            narrative: result.narrative || "No narrative.",
            analystSummary: result.analystSummary || "No summary.",
            technicalOutlook: result.technicalOutlook || "No tech data.",
            socialVibe: result.socialVibe || "No vibe data.",
            riskAnalysis: result.riskAnalysis || "No risk data.",
            strategy: result.strategy || "WATCH",
            analysis: result.analysis || [],
            riskLevel: result.riskLevel || 'MEDIUM',
            riskReason: result.riskReason || '',
            score: typeof result.score === 'number' ? result.score : 4,
            verdict: result.verdict || 'FADE',
            displayEmoji: result.displayEmoji || '🤖',
            recommendation: result.recommendation || 'PASS',
            advice: result.advice || '',
            vibe: result.vibe || ''
        };
    }

    async analyzeTweetBatch(tweets: { id: string; text: string; author?: string }[]): Promise<Array<{ symbol: string; sentiment: string; reason: string; source_id: string }>> {
        if (tweets.length === 0) return [];

        // Tweetleri numaralandırarak birleştiriyoruz, Author bilgisini ekliyoruz
        const userContent = tweets.map(t => {
            const authorPart = t.author ? ` (Author: @${t.author})` : '';
            return `ID_${t.id}${authorPart}: ${t.text.replace(/\n/g, ' ')}`;
        }).join('\n\n');

        const systemPrompt = `
You are an expert Crypto Trend Hunter (Jeweler Mode).
Analyze the provided tweets (Format: "ID_xxx (Author: @user): Content") regarding ERC-8004, Hybrid Tokens, or new tech trends.

**STRICT RULES:**
1. Ignore spam, airdrops, giveaways, and generic empty hype.
2. Identify only HIGH POTENTIAL projects with real community interest or solid tech mentions.
3. Look for Contract Addresses (CA) or Tickers ($SYM).
4. OUTPUT MUST BE VALID JSON.
5. **BOOST SCORE**: If tweet is from a known Alpha Account (e.g. 8004_scan, 8004tokens, DavideCrapis), give it higher sentiment and trust.

**JSON OUTPUT FORMAT:**
{
  "gems": [
    { 
      "symbol": "$SYMBOL", 
      "sentiment": "Score 1-10", 
      "reason": "Short summary explaining why it is a gem (IN TURKISH LANGUAGE)",
      "source_id": "Extract the numeric ID from the input (e.g. if input is ID_12345, output '12345')"
    }
  ]
}
If no gems found, return: { "gems": [] }
`;

        try {
            logger.info(`[xAI Grok] Batch analyzing ${tweets.length} tweets...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning", // Ultra Low Cost Model
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.1, // Düşük sıcaklık = Daha tutarlı JSON
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) return [];

            const parsed = JSON.parse(content);
            // Artık "gems" anahtarının geleceğinden eminiz
            return parsed.gems || [];

        } catch (err) {
            logger.error(`[xAI Batch] Analysis failed: ${err}`);
            return [];
        }
    }
}
