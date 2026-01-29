import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/Logger';

export interface AIAnalysisResult {
    narrative: string; // The "Story"
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'DANGEROUS';
    riskReason: string;
    vibeScore: number; // 0-100
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
        You are an expert crypto narrative analyst. 
        Analyze these tweets about "$${symbol}".
        Task:
        1. Summarize WHY it is trending.
        2. Assess RISK (Low/High).
        3. Give Vibe Score (0-100).
        
        Output JSON only:
        { "narrative": "One sentence summary in Turkish", "riskLevel": "LOW/HIGH", "riskReason": "Short reason in Turkish", "vibeScore": 85, "displayEmoji": "🔥" }
        `;

        const userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`;

        try {
            if (useGemini) {
                // GEMINI API Implementation
                // Ensure we don't accidentally use 'gpt-4o-mini' from env if user switched providers
                let model = config.AI_MODEL;
                if (!model || !model.startsWith('gemini')) {
                    model = 'gemini-1.5-flash';
                }

                logger.info(`[LLM] Using Gemini Model: ${model}`); // Debug log

                let result = await this.callGemini(model, systemPrompt + "\n\n" + userContent);

                // Fallback: If 3.0 or custom fails, try standard 1.5-flash
                if (!result && model !== 'gemini-1.5-flash') {
                    logger.warn(`[LLM] Model ${model} failed. Retrying with 'gemini-1.5-flash' fallback...`);
                    result = await this.callGemini('gemini-1.5-flash', systemPrompt + "\n\n" + userContent);
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
            narrative: result.narrative || "Trend analizi yapılamadı.",
            riskLevel: result.riskLevel || 'MEDIUM',
            riskReason: result.riskReason || '',
            vibeScore: result.vibeScore || 50,
            displayEmoji: result.displayEmoji || '🤖'
        };
    }

    private async callGemini(model: string, prompt: string): Promise<any | null> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;
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
            logger.warn(`[LLM] Gemini attempt (${model}) failed: ${error.message}`);
            return null;
        }
    }
}
