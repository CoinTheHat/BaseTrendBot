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

    async analyzeToken(symbol: string, tweets: string[], tokenStats?: string): Promise<AIAnalysisResult | null> {
        // Prioritize Gemini if available (Free), else OpenAI
        const useGemini = !!config.GEMINI_API_KEY;

        if (!config.OPENAI_API_KEY && !config.GEMINI_API_KEY) {
            logger.warn('[LLM] No API Key (OpenAI or Gemini) provided. Skipping AI analysis.');
            return null;
        }

        const hasTweets = tweets.length > 0;

        let systemPrompt = '';
        let userContent = '';

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
        - ALL text must be in TURKISH except technical terms (Honeypot, Rugpull, Liquidity, etc.)
        - Write naturally like a crypto analyst talking to a Turkish trader
        - Based on your score (0-10), provide specific recommendation:
          * 8-10: "GÜÇLÜ ALINABİLİR" with optimistic comment
          * 5-7: "DİKKATLİ İZLE" with cautious comment  
          * 0-4: "UZAK DUR" with warning

        Output strictly these JSON fields (in Turkish):
        {
            "headline": "Short, punchy title (e.g. '🚨 GEM BULUNDU: $SYMBOL', '⚠️ RUG UYARISI', '💎 GÜVENLİ OYNATMA')",
            "narrative": "Token'ın ruhunu ve karakterini anlatan tek cümle.",
            "analysis": [
                "Neden yükseliyor - sosyal kanıt",
                "Topluluk ve dev kontrolü"
            ],
            "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
            "riskReason": "Spesifik uyarı veya güven nedeni.",
            "score": 8, // 0-10 Integer based on your conviction (10 = Kesinlikle Al, 0 = Scam)
            "recommendation": "GÜÇLÜ ALINABİLİR" | "DİKKATLİ İZLE" | "UZAK DUR",
            "advice": "1 cümlelik kısa tavsiye (e.g. 'Sosyal medya patlıyor, trendin başındayız.')",
            "vibe": "Token'ın ruh hali ve karakter analizi (e.g. 'Agresif ama riskli bir topluluk hareketi')",
            "displayEmoji": "🔥" | "💩" | "👀"
        }
        `;

            userContent = `Tweets:\n${tweets.slice(0, 15).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`;

        } else {
            // FALLBACK: No Twitter Data - Technical Only Analysis
            logger.info(`[LLM] No tweets for $${symbol}. using Technical Fallback Analysis.`);

            systemPrompt = `
            You are a Risk Analyst for Memecoins. 
            We have NO social data (Twitter) for the token "$${symbol}".
            You must analyze the risk based PURELY on the provided technical statistics (Market Cap, Liquidity, Volume, etc.).

            Statistics:
            ${tokenStats || 'No technical data provided.'}

            Output Rules:
            - ALL text must be in TURKISH except technical terms
            - Be skeptical about tokens without social proof
            - Based on score, provide recommendation:
              * 8-10: "GÜÇLÜ ALINABİLİR" (very rare without socials)
              * 5-7: "DİKKATLİ İZLE" 
              * 0-4: "UZAK DUR"

            Output strict JSON (in Turkish):
            {
                "headline": "Teknik Analiz Başlığı (e.g. '⚠️ SOSYAL YOK - YÜKSEK RİSK', '📊 HACİM PATLAMASI')",
                "narrative": "Teknik durumun tek cümlelik özeti.",
                "analysis": [
                    "Hacim/Likidite gözlemi",
                    "Sosyal kanıt eksikliği riski"
                ],
                "riskLevel": "HIGH", 
                "riskReason": "Sosyal veri bulunamadı.",
                "score": 4, // Cap score at 5 for unknowns, unless metrics are insane.
                "recommendation": "DİKKATLİ İZLE",
                "advice": "Hacim var ama sosyal kanıt yok, küçük test pozisyonu denenebilir.",
                "vibe": "Sessiz bir token, kimse konuşmuyor ama hacim var",
                "displayEmoji": "🎲"
            }
            `;

            userContent = "Analyze this technical data.";
        }

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
