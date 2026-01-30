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
    recommendation?: string;
    advice?: string;
    vibe?: string;
}

export class LLMService {
    private keyManager: GeminiKeyManager;

    constructor() {
        this.keyManager = new GeminiKeyManager(config.GEMINI_KEYS);
    }

    async analyzeToken(symbol: string, tweets: string[], tokenStats?: string): Promise<AIAnalysisResult | null> {
        // Validation: Pre-check is done in NarrativeEngine usually, but we safeguard here too.
        // If caller passed 0 tweets, we treat it as technical analysis or skip if strictly required.
        // User requested: "Likiditesi $5,000 altı olan veya 0 tweeti olan tokenları bu modellerin hiçbirine gönderme"
        // Since we only get 'tokenStats' string here, we rely on the caller (NarrativeEngine) to filter Liquidity.
        // We CAN check tweets length here though.

        const hasTweets = tweets.length > 0;

        let systemPrompt = '';
        let userContent = '';

        // Standardized Prompt Construction
        if (hasTweets) {
            systemPrompt = `
        You are an elite Crypto Degen Detective and Risk Analyst.
        Your job is to analyze Twitter/X data for a new Solana token "$${symbol}" and determine if it's a hidden gem, a dangerous scam, or just noise.
        
        Analyze the provided tweets critically. Look for:
        - **Organic Hype vs. Bot Spam:** Do the tweets look real or scripted?
        - **Influencer Involvement:** Are big names calling it? Who?
        - **Narrative Strength:** Is there a real meme/story or just a random coin?
        - **Red Flags:** "Revoke authority", "Liquidity locked", "Pre-sale" mentions (if any).

        CRITICAL INSTRUCTION: 
        If users mention 'scam', 'rug', 'honeypot', 'fake' or if tweets are clearly bot spam, 
        IMMEDIATELY set score < 3 and recommend UZAK DUR. Do not be fooled by high volume.

        Output Rules:
        - ALL text must be in TURKISH
        - Based on your score (0-10), provide specific recommendation:
          * 8-10: "GÜÇLÜ ALINABİLİR" with optimistic comment
          * 5-7: "DİKKATLİ İZLE" with cautious comment  
          * 0-4: "UZAK DUR" with warning

        Output strictly these JSON fields:
        {
            "headline": "Short, punchy title (e.g. '🚨 GEM BULUNDU', '⚠️ RUG UYARISI')",
            "narrative": "Token'ın ruhunu ve karakterini anlatan tek cümle.",
            "analysis": [
                "Neden yükseliyor - sosyal kanıt",
                "Topluluk ve dev kontrolü"
            ],
            "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
            "riskReason": "Spesifik uyarı veya güven nedeni.",
            "score": 8, // 0-10 Integer
            "recommendation": "GÜÇLÜ ALINABİLİR" | "DİKKATLİ İZLE" | "UZAK DUR",
            "advice": "1 cümlelik kısa tavsiye (e.g. 'Sosyal medya patlıyor, trendin başındayız.')",
            "vibe": "Token'ın ruh hali (e.g. 'Agresif', 'Eğlenceli')",
            "displayEmoji": "🔥" | "💩" | "👀"
        }
        `;
            userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}\n\nStats:\n${tokenStats || ''}`;

        } else {
            // Technical Analysis Fallback
            systemPrompt = `
            You are a Risk Analyst for Memecoins. 
            We have NO social data (Twitter) for the token "$${symbol}".
            Analyze risk based PURELY on technicals.

            Statistics:
            ${tokenStats || 'No technical data provided.'}

            Output Strict JSON (Turkish):
            {
                "headline": "⚠️ TUNNEL VISION (NO SOCIALS)",
                "narrative": "Sadece teknik verilere dayalı analiz.",
                "analysis": ["Hacim ve Likidite durumu"],
                "riskLevel": "HIGH", 
                "riskReason": "Sosyal veri yok.",
                "score": 4, 
                "recommendation": "DİKKATLİ İZLE",
                "advice": "Sosyal kanıt yok, risk yüksek.",
                "vibe": "Sessiz",
                "displayEmoji": "🎲"
            }
            `;
            userContent = "Analyze this technical data.";
        }

        // ROUTING LOGIC
        return await this.generateAnalysis(systemPrompt, userContent, symbol);
    }

    private async generateAnalysis(systemPrompt: string, userContent: string, symbol: string): Promise<AIAnalysisResult | null> {

        // 1. Try GROQ (Primary)
        if (config.GROQ_API_KEY) {
            try {
                logger.info(`[AI Router] Trying Primary: Groq (${config.GROQ_MODEL}) for $${symbol}`);
                const result = await this.callOpenAICompatible(
                    'https://api.groq.com/openai/v1/chat/completions',
                    config.GROQ_API_KEY,
                    config.GROQ_MODEL,
                    systemPrompt,
                    userContent
                );
                if (result) return this.normalizeResult(result);
            } catch (e: any) {
                logger.warn(`[AI Router] Groq failed for $${symbol} (${e.message}), switching to DeepSeek...`);
            }
        }

        // 2. Try DEEPSEEK (Fallback)
        if (config.DEEPSEEK_API_KEY) {
            try {
                logger.info(`[AI Router] Trying Fallback: DeepSeek (${config.DEEPSEEK_MODEL}) for $${symbol}`);
                const result = await this.callOpenAICompatible(
                    'https://api.deepseek.com/chat/completions',
                    config.DEEPSEEK_API_KEY,
                    config.DEEPSEEK_MODEL,
                    systemPrompt,
                    userContent
                );
                if (result) return this.normalizeResult(result);
            } catch (e: any) {
                logger.warn(`[AI Router] DeepSeek failed for $${symbol} (${e.message}), switching to Gemini...`);
            }
        }

        // 3. Try GEMINI (Last Resort)
        if (this.keyManager.hasKeys()) {
            logger.info(`[AI Router] Trying Last Resort: Gemini for $${symbol}`);
            // Use the existing rotating logic, but simplified call
            const result = await this.tryGeminiWithRotation(config.AI_MODEL, systemPrompt, userContent, symbol);
            if (result) return result; // Already normalized
        }

        logger.error(`[AI Router] All Providers Failed for $${symbol}`);
        return null; // All failed
    }

    // Generic Helper for OpenAI-Compatible APIs (Groq, DeepSeek)
    private async callOpenAICompatible(endpoint: string, apiKey: string, model: string, system: string, user: string): Promise<any | null> {
        try {
            const response = await axios.post(
                endpoint,
                {
                    model: model,
                    messages: [
                        { role: 'system', content: system + "\n IMPORTANT: Return ONLY valid JSON." },
                        { role: 'user', content: user }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.5
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000 // 15s timeout
                }
            );

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) throw new Error('Empty response from LLM');
            return JSON.parse(content);

        } catch (error: any) {
            // Throw up to allow router to catch
            throw new Error(error.response?.data?.error?.message || error.message);
        }
    }

    private async tryGeminiWithRotation(initialModel: string, systemPrompt: string, userContent: string, symbol: string): Promise<AIAnalysisResult | null> {
        // Reuse existing rotation logic but adapt to return normalized result
        const fallbacks = ['gemini-2.0-flash-exp', 'gemini-2.5-flash', 'gemini-1.5-flash'];
        const uniqueModels = [...new Set([initialModel, ...fallbacks])];

        for (const currentModel of uniqueModels) {
            const result = await this.callGeminiAutoRotate(currentModel, systemPrompt + "\n\n" + userContent, symbol);
            if (result) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.normalizeResult(result);
            }
        }
        return null;
    }

    private async callGeminiAutoRotate(model: string, prompt: string, symbol: string): Promise<any | null> {
        const maxRetries = 2; // Reduced retries for last resort to fail fast
        let attempts = 0;

        while (attempts < maxRetries) {
            const keyInfo = this.keyManager.getNextKey();
            if (!keyInfo) {
                logger.warn(`[LLM] Gemini: No available keys for $${symbol} (all cooled down or missing).`);
                return null;
            }

            // logger.info(`[LLM] Gemini Key #${keyInfo.index + 1} (${model})`);

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyInfo.key}`;
            try {
                const response = await axios.post(url, {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: "application/json" }
                }, { timeout: 15000 }); // 15s timeout
                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                return text ? JSON.parse(text) : null;
            } catch (error: any) {
                const status = error.response?.status;
                const errorMsg = error.response?.data?.error?.message || error.message;
                if (status === 429) {
                    logger.warn(`[LLM] Gemini Key #${keyInfo.index + 1} QUOTA EXCEEDED (429) for $${symbol}. Cooldown 60s.`);
                    this.keyManager.markCooldown(keyInfo.key);
                    attempts++;
                    continue;
                }
                logger.warn(`[LLM] Gemini attempt (${model}) failed for $${symbol}: ${status} - ${errorMsg}`);
                return null;
            }
        }
        logger.warn(`[LLM] Gemini: Max retries exhausted for $${symbol} with model ${model}.`);
        return null;
    }

    private normalizeResult(result: any): AIAnalysisResult {
        return {
            headline: result.headline || `🚨 ANALYZING: ${config.AI_MODEL}`,
            narrative: result.narrative || "Trend analizi yapılamadı.",
            analysis: result.analysis || ["Veri yetersiz."],
            riskLevel: result.riskLevel || 'MEDIUM',
            riskReason: result.riskReason || '',
            score: typeof result.score === 'number' ? result.score : 5,
            verdict: result.verdict || 'WATCH',
            displayEmoji: result.displayEmoji || '🤖',
            recommendation: result.recommendation || 'DİKKATLİ İZLE',
            advice: result.advice || '',
            vibe: result.vibe || ''
        };
    }
}

class GeminiKeyManager {
    private keys: string[];
    private currentIndex: number = 0;
    private cooldowns: Map<string, number> = new Map(); // Key -> Cooldown Expiry Timestamp

    constructor(keys: string[]) {
        this.keys = keys;
    }

    hasKeys(): boolean {
        return this.keys.length > 0;
    }

    getNextKey(): { key: string, index: number } | null {
        if (this.keys.length === 0) return null;
        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const ptr = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[ptr];
            if (now > (this.cooldowns.get(key) || 0)) {
                this.currentIndex = (ptr + 1) % this.keys.length;
                return { key, index: ptr };
            }
        }
        return null;
    }

    markCooldown(key: string) {
        this.cooldowns.set(key, Date.now() + 60000);
    }
}
