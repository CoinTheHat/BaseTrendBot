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

    private sanitizeText(text: string): string {
        if (!text) return '';
        return text
            .replace(/\n/g, ' ')
            .replace(/\\/g, '/') // Replace backslashes with forward slashes to avoid escape issues
            .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
            .trim();
    }

    async analyzeToken(token: TokenSnapshot, tweets: string[], retries = 1): Promise<AIAnalysisResult | null> {
        const hasTweets = tweets.length > 0;
        const { systemPrompt, userContent } = this.buildPrompt(token, tweets, hasTweets);

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                logger.info(`[xAI Grok] Analyzing $${token.symbol} (Attempt ${attempt + 1}) with ${config.XAI_MODEL || 'grok-4-1-fast-non-reasoning'}...`);

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

                const result = JSON.parse(content);
                return this.normalizeResult(result);

            } catch (error: any) {
                logger.warn(`[xAI Grok] Analysis attempt ${attempt + 1} failed for $${token.symbol}: ${error.message}`);

                if (attempt === retries) {
                    if (error.status === 401 || error.message.includes('API key')) {
                        logger.error('[xAI Grok] FATAL: Invalid API Key. Please check config.');
                    }
                    return null;
                }

                // Backoff before retry
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        return null;
    }

    private buildPrompt(token: TokenSnapshot, tweets: string[], hasTweets: boolean): { systemPrompt: string; userContent: string } {
        // ... (Prompt logic remains mostly same, just optimized for Grok)
        const systemPrompt = `
Sen Kıdemli bir Kripto Degen Analistisin (xAI Grok tabanlı). Görevin, piyasa verilerine ve son tweetlere dayanarak Solana meme tokenlarını analiz etmek.
AMACIMIZ: Yeni çıkan, hikayesi olan ve hızlıca 2x yapabilecek "Fresh" tokenları yakalamak.

⚠️ OTOMATIK 0/10 PUAN VER (BLACK LIST):
- Eğer token ismi şunları içeriyorsa: "pedo", "child", "jew", "nazi", "hitler", "rape", "terrorist", "kill"
- Eğer top10HoldersPercent > 50% ise (Whale rug riski!)
- Eğer holderCount < 50 ise (Bot activity!)
- "Rug riski yüksek" diyorsan asla puan verme.

✅ PUANLAMA KRİTERLERİ (TOPLAM 100 -> 10 ÜZERİNDEN):
1. Güvenlik (40 Puan):
   - holderCount > 100: +15
   - top10HoldersPercent < 40%: +15
   - Token Age 20-120 dk: +10

2. Momentum (30 Puan):
   - Volume/Liquidity > 2: +15
   - Buy/Sell Ratio %55-65: +15

3. Sosyal Vibe (20 Puan):
   - Tweetler bot değilse: +10
   - Meme potansiyeli yüksekse: +10

4. Teknik (10 Puan):
   - Market Cap $50k-$300k arası: +5
   - Likidite > $10k: +5

**Giriş Verileri:**
- Sembol: ${token.symbol}
- Fiyat: $${token.priceUsd}
- Likidite: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Hacim (5dk): $${token.volume5mUsd}
- Token Yaşı: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / (60 * 60 * 1000)) + 'saat' : 'Bilinmiyor'} (Genç tokenlar daha riskli ama kazançlı olabilir)
- Top 10 Holder: ${token.top10HoldersSupply ? token.top10HoldersSupply.toFixed(2) + '%' : 'Bilinmiyor'}
- Toplam Holder: ${token.holderCount || 'Bilinmiyor'}

**Görev:**
JSON formatında derinlemesine ve yapılandırılmış bir analiz sun. TÜM ÇIKTILAR %100 TÜRKÇE OLMALIDIR.

**Analiz Gereksinimleri:**
1. **Analist Özeti**: Bu token neden radarımızda?
2. **Güvenlik & Holder**: Balina riski var mı? Holder dağılımu homojen mi? (Bunu kontrol etmezsen kovulursun).
3. **Sosyal Vibe**: Topluluk organik mi?
4. **Puan (0-10)**: Yukarıdaki kriterlere göre hesapla. 7 altı çöp.

**JSON Çıktı Formatı (KESİN):**
{
    "headline": "Kısa ve Çarpıcı Başlık",
    "narrative": "Genel hikaye...",
    "analystSummary": "Özet...",
    "technicalOutlook": "Teknik yorum...",
    "socialVibe": "Sosyal yorum...",
    "riskAnalysis": "Risk analizi (Holder verisine dayanarak)...",
    "strategy": "Aksiyon (Al/Sat/Bekle)...",
    "analysis": ["Madde 1", "Madde 2"],
    "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
    "riskReason": "Risk nedeni",
    "score": number, 
    "verdict": "APE" | "WATCH" | "FADE",
    "displayEmoji": "Emoji",
    "recommendation": "Tavsiye",
    "advice": "Kısa tavsiye",
    "vibe": "Kısa vibe"
}
`;
        const userContent = hasTweets
            ? `Tweets:\n${tweets.slice(0, 20).map(t => `- ${this.sanitizeText(t)}`).join('\n')}`
            : `Twitter verisi yok. Sadece teknik verileri analiz et. Risk seviyesini yüksek tut.`;

        return { systemPrompt, userContent };
    }

    private normalizeResult(result: any): AIAnalysisResult {
        return {
            headline: result.headline || `🚨 ANALYZING`,
            narrative: result.narrative || "Trend analizi yapılamadı.",
            analystSummary: result.analystSummary || "Özet yok.",
            technicalOutlook: result.technicalOutlook || "Teknik veri yok.",
            socialVibe: result.socialVibe || "Vibe verisi yok.",
            riskAnalysis: result.riskAnalysis || "Risk analizi yok.",
            strategy: result.strategy || "Strateji yok.",
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

    async analyzeTweetBatch(tweets: { id: string; text: string; author?: string }[]): Promise<Array<{ symbol: string; sentiment: string; reason: string; source_id: string }>> {
        if (tweets.length === 0) return [];

        // Tweetleri numaralandırarak birleştiriyoruz, Author bilgisini ekliyoruz
        const userContent = tweets.map(t => {
            const authorPart = t.author ? ` (Author: @${t.author})` : '';
            return `ID_${t.id}${authorPart}: ${this.sanitizeText(t.text)}`;
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

    /**
     * TWITTER SENTIMENT SCORING (Two-Stage Filter)
     * Skeptical AI evaluates social sentiment for tokens that passed technical filters.
     * Returns score 0-30 (minimum 20 to pass)
     */
    async scoreTwitterSentiment(token: TokenSnapshot, tweets: string[]): Promise<{
        vibeScore: number; // Final score (-100 to +100 for storage/logs)
        score: number; // Converted to 0-30 for compatibility
        reasoning: string;
        redFlags: string[];
    } | null> {

        const tweetSection = tweets.length > 0
            ? tweets.slice(0, 100).map(t => `- ${this.sanitizeText(t).substring(0, 200)}`).join('\n')
            : '';

        if (tweets.length === 0) {
            return {
                vibeScore: 0,
                score: 0,
                reasoning: 'No Twitter data available',
                redFlags: ['No social presence']
            };
        }

        const systemPrompt = `
You are a Crypto Pattern Matcher AI. Your job is NOT to judge arbitrarily, but to validata a STRUCTED CHECKLIST.

**CHECKLIST RULES (Detect these signals):**

-- NEGATIVE SIGNALS --
[ALPHA_GROUP] : "Alpha Group" links, invite spam, "Join our premium".
[PUMP_KEYWORD]: "Pump", "Raid", "Shill", "Push" keywords used aggressively.
[HYPE_SPAM]   : "100x gem", "Moon mission", "LFG", "Send it" spam without substance.
[LOW_QUALITY] : Only emojis, new accounts, bad grammar, no real content.

-- POSITIVE SIGNALS --
[TECH_ART]    : Unique, thoughtful comments about the TECH, ART, or USE CASE.
[ORIGINAL_MEME]: Creative, funny, original memes (not just random gifs).
[SMART_MONEY] : Analysis of Holders, Liquidity, Support/Resistance levels (Technical discussion).
[REAL_QUESTIONS]: Genuine questions ("Who is dev?", "Roadmap?", "Website?") - showing organic interest.

**AI DISCRETION (Context Score):**
After checking the list above, give a "Context Score" between -7 and +7.
- Use POSITIVE (+1 to +7) if the general vibe is organic, funny, or clever.
- Use NEGATIVE (-1 to -7) if it feels forced, bot-like, or desperate.
- Use 0 if neutral.

**OUTPUT FORMAT (JSON):**
{
    "checklist": ["ALPHA_GROUP", "TECH_ART"], // List ALL detected signals
    "contextScore": number, // Max -7 to +7
    "reasoning": "Explain in 1 sentence (Turkish)"
}
`;

        try {
            logger.info(`[AI Auditor] Analyzing social quality for ${token.symbol}...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Tweets:\n${tweetSection}` }],
                temperature: 0.1,
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) return null;

            const result = JSON.parse(content);
            const triggeredRules: string[] = result.checklist || [];
            const contextScore = Math.max(-7, Math.min(7, result.contextScore || 0)); // Clamp -7 to +7

            // --- TYPESCRIPT SCORING ENGINE (Exact Math) ---
            let calculatedScore = 0;
            const scoringMap: Record<string, number> = {
                // Penalties
                'ALPHA_GROUP': -5,
                'PUMP_KEYWORD': -5,
                'HYPE_SPAM': -3,
                'LOW_QUALITY': -2,
                // Rewards
                'TECH_ART': 8,
                'ORIGINAL_MEME': 8,
                'SMART_MONEY': 8,
                'REAL_QUESTIONS': 8
            };

            const redFlags: string[] = [];

            triggeredRules.forEach(rule => {
                const points = scoringMap[rule] || 0;
                calculatedScore += points;
                if (points < 0) redFlags.push(rule);
            });

            // Add AI Context Score
            calculatedScore += contextScore;

            // Normalize for storage (-100 to +100 range implied, but now mostly -20 to +40 range)
            const vibeScore = calculatedScore;

            // Map to 0-30 Compatibility Score (For total Score)
            // If negative, contributes 0.
            let compatScore = 0;
            if (vibeScore > 0) {
                // Map plausible max (approx 40) to 30. 
                // If score is 40 -> 30. If 20 -> 15.
                compatScore = Math.min(30, (vibeScore / 40) * 30);
            }

            logger.info(`[AI Auditor] ${token.symbol}: Vibe ${vibeScore} (Checklist: ${triggeredRules.length}, Context: ${contextScore}) | Compat ${compatScore.toFixed(0)}/30 | ${result.reasoning}`);

            return {
                vibeScore: vibeScore,
                score: Math.floor(compatScore),
                reasoning: result.reasoning,
                redFlags: redFlags
            };

        } catch (err: any) {
            logger.error(`[AI Auditor] Failed for ${token.symbol}: ${err.message}`);
            return null;
        }
    }

    /**
     * POST-SNIPE ANALYSIS
     * Diagnostic review after mechanical alert.
     */
    async analyzePostSnipe(token: TokenSnapshot, tweets: string[] = [], retries = 1): Promise<{
        momentumPhase: string;
        priceContext: string;
        riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
        explanation: string[];
        socialSummary: string;
    } | null> {

        const tweetSection = tweets.length > 0
            ? `SOCIAL SENTIMENT (RAW TWEETS):\n${tweets.slice(0, 100).map(t => `- ${this.sanitizeText(t).substring(0, 200)}`).join('\n')}`
            : `SOCIAL SENTIMENT: VERI YOK. (Bu durumda TEKNIK VERILERE -Age, MC, Liq- odaklanarak bir yorum yapınız).`;

        const systemPrompt = `
You are a fundamental researcher and narrative analyst reviewing a Solana token.

**USER REQUEST:** 
- "Don't just tell me it's hyped. Tell me WHAT IT IS."
- "Does this project's logic make sense? Is it a good idea?"
- "Ignore '100x' or 'Moon' spam. Focus on the CONCEPT."
- "If NO TWEETS: Perform a Technical Analysis based on the Token Snapshot (MC/Liq ratio, Age, Symbol potential)."

TOKEN SNAPSHOT:
- Symbol: ${this.sanitizeText(token.symbol)}
- Name: ${this.sanitizeText(token.name || token.symbol)}
- Market Cap: $${token.marketCapUsd?.toLocaleString() || '0'}
- Liquidity: $${token.liquidityUsd?.toLocaleString() || '0'}
- Age: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) : 'N/A'} min
- Volume (5m): $${(token.volume5mUsd || 0).toLocaleString()}

${tweetSection}

**YOUR MISSION:**
1. **Identify the Concept:** What is this token actually about? (Meme? AI? Utility? DeFi?). If tweets are missing, use the Name/Symbol to infer.
2. **Logic Check:** Is the narrative catchy, clever, or unique? Or is it a low-effort copy?
3. **Filter Hype:** Ignore "LFG", "Moon", "Send it" comments. Focus on *why* people are excited (the narrative).
4. **Technical Focus (IF NO TWEETS):** Evaluate if the Market Cap is healthy relative to Liquidity. Commentary on whether the token is "Early" or "Risky" based on its age (${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) : 'N/A'} min).

**OUTPUT FORMAT (STRICT JSON):**
{
    "momentumPhase": "Early" | "Mid" | "Late" | "Exhausted",
    "priceContext": "Fresh move" | "Extended" | "Overextended",
    "riskLevel": "Low" | "Medium" | "High",
    "socialSummary": "EXPLAIN THE PROJECT (Turkish): 1 sentence on WHAT it is + 1 sentence on IF the logic works OR a Technical Outlook. (e.g. 'Bu bir politik meme projesi. Henüz çok yeni (X dk) ve likidite/MC oranı sağlıklı görünüyor.')",
    "explanation": ["Concept: [Brief Description]", "Logic: [Your Verdict]", "Vibe: [Community Sentiment]"]
}
`;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const completion = await this.xai.chat.completions.create({
                    model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning",
                    messages: [{ role: "system", content: systemPrompt }],
                    temperature: 0.2,
                    response_format: { type: "json_object" }
                });

                const content = completion.choices[0].message.content;
                if (!content) throw new Error('Empty response from AI');

                const parsed = JSON.parse(content);

                // Final validation of required fields
                if (!parsed.socialSummary) throw new Error('Missing socialSummary in AI response');

                return parsed;

            } catch (err: any) {
                logger.warn(`[LLM] Post-Snipe Analysis attempt ${attempt + 1} failed: ${err.message}`);
                if (attempt === retries) {
                    logger.error(`[LLM] All attempts failed for ${token.symbol}. Generating fallback.`);
                    return {
                        momentumPhase: 'Unknown',
                        priceContext: 'Unknown',
                        riskLevel: 'MEDIUM',
                        explanation: ['AI analysis failed after multiple attempts'],
                        socialSummary: `AI analizi şu an yapılamadı, ancak teknik puan yüksek olduğu için paylaşılmıştır. (${token.symbol})`
                    };
                }
                // Backoff
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        return null;
    }
}
