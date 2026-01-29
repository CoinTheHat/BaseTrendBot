import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/Logger';

export interface AIAnalysisResult {
    headline: string;
    narrative: string;
    analysis: string[]; // Key insights
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
    riskReason: string;
    score: number; // 0-10
    verdict: 'APE' | 'WATCH' | 'FADE';
    displayEmoji: string;
}

export class LLMService {

    constructor() { }

    async analyzeToken(symbol: string, tweets: string[]): Promise<AIAnalysisResult | null> {
        // Prioritize Gemini if available (Free), else OpenAI
        const useGemini = !!config.GEMINI_API_KEY;

        if (!config.OPENAI_API_KEY && !config.GEMINI_API_KEY) {
            logger.warn('[LLM] No API Key (OpenAI or Gemini) provided. Skipping AI analysis.');
            return null;
        }

        if (tweets.length === 0) return null;

        const systemPrompt = `
        You are an elite Crypto Degen Detective and Risk Analyst.
        Your job is to analyze Twitter/X data for a new Solana token "$${symbol}" and determine if it's a hidden gem, a dangerous scam, or just noise.
        
        Analyze the provided tweets critically. Look for:
        - **Organic Hype vs. Bot Spam:** Do the tweets look real or scripted?
        - **Influencer Involvement:** Are big names calling it? Who?
        - **Narrative Strength:** Is there a real meme/story or just a random coin?
        - **Red Flags:** "Revoke authority", "Liquidity locked", "Pre-sale" mentions (if any).

        CRITICAL INSTRUCTION: 
        If users mention 'scam', 'rug', 'honeypot', 'fake' or if tweets are clearly bot spam, 
        IMMEDIATELY set score < 3 and Verdict: FADE. Do not be fooled by high volume.

        Task:
        1. Explain WHY it is trending (The "Alpha").
        2. Identify specific RISKS (The "FUD").
        3. Give a Verdict: APE (Buy), WATCH (Wait), or FADE (Ignore/Risky).

        Output strictly these JSON fields (in Turkish):
        {
            "headline": "Short, punchy title (e.g. '🚨 GEM DETECTED: $SYMBOL', '⚠️ RUG WARNING', '💎 SAFE PLAY')",
            "narrative": "One sharp sentence explaining the core narrative/meme.",
            "analysis": [
                "Bullet point 1: Why it's hyped",
                "Bullet point 2: Community/Dev check"
            ],
            "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
            "riskReason": "Specific warning.",
            "score": 8, // 0-10 Integer based on your conviction (10 = Must Ape, 0 = Scam)
            "verdict": "APE" | "WATCH" | "FADE",
            "displayEmoji": "🔥" | "💩" | "👀"
        }
        `;

        const userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`;

        try {
            if (useGemini) {
                // GEMINI API Implementation
                // Ensure we don't accidentally use 'gpt-4o-mini' from env if user switched providers
                let model = (config.AI_MODEL || '').trim();
                if (!model || !model.startsWith('gemini')) {
                    model = 'gemini-2.0-flash-exp'; // Try the newest experimental first
                }

                logger.info(`[LLM] Requesting Gemini Model: ${model}`);

                let result = await this.callGemini(model, systemPrompt + "\n\n" + userContent);

                // Fallback Chain: 2.5-flash -> 3-preview -> 1.5-flash
                if (!result) {
                    const fallbacks = [
                        'gemini-2.5-flash',
                        'gemini-3-flash-preview',
                        'gemini-1.5-flash',
                        'gemini-1.5-pro'
                    ];

                    for (const fbModel of fallbacks) {
                        if (fbModel === model) continue; // Skip if already tried

                        logger.warn(`[LLM] Model ${model} failed. Retrying with '${fbModel}'...`);
                        result = await this.callGemini(fbModel, systemPrompt + "\n\n" + userContent);
                        if (result) {
                            model = fbModel; // Update current success model
                            break;
                        }
                    }
                }

                if (result) return this.normalizeResult(result);
                return null;

            } else {
                // OPENAI Legacy Implementation
                const response = await axios.post(
                    'https://api.openai.com/v1/chat/completions',
                    {
                        model: config.AI_MODEL || 'gpt-4o-mini',
                        messages: [
                            { role: 'system', content: 'You are a JSON-only crypto analysis bot.' },
                            { role: 'user', content: systemPrompt + "\n" + userContent }
                        ],
                        response_format: { type: "json_object" }
                    },
                    { headers: { 'Authorization': `Bearer ${config.OPENAI_API_KEY}` } }
                );
                const content = response.data?.choices?.[0]?.message?.content;
                const result = JSON.parse(content || '{}');
                return this.normalizeResult(result);
            }

        } catch (error: any) {
            if (error.response?.status === 429) {
                logger.error(`[LLM] ❌ QUOTA EXCEEDED (429). Check billing.`);
            } else {
                logger.error(`[LLM] Analysis failed: ${error.message}`);
            }
            return null;
        }
    }

    private normalizeResult(result: any): AIAnalysisResult {
        return {
            headline: result.headline || `🚨 ANALYZING: $${config.AI_MODEL}`,
            narrative: result.narrative || "Trend analizi yapılamadı.",
            analysis: result.analysis || ["Veri yetersiz."],
            riskLevel: result.riskLevel || 'MEDIUM',
            riskReason: result.riskReason || '',
            score: typeof result.score === 'number' ? result.score : 5,
            verdict: result.verdict || 'WATCH',
            displayEmoji: result.displayEmoji || '🤖'
        };
    }

    private async callGemini(model: string, prompt: string): Promise<any | null> {
        const apiKey = (config.GEMINI_API_KEY || '').trim();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        try {
            const response = await axios.post(url, {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    responseMimeType: "application/json"
                }
            });
            const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            return text ? JSON.parse(text) : null;
        } catch (error: any) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorMsg = data?.error?.message || error.message;

            logger.warn(`[LLM] Gemini attempt (${model}) failed: ${status} - ${errorMsg}`);
            return null;
        }
    }
}
