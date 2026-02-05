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
            logger.info(`[xAI Grok] Analyzing $${token.symbol} with ${config.XAI_MODEL || 'grok-4-1-fast-non-reasoning'}...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning", // Ultra Low Cost Model
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
            logger.error(`[xAI Grok] Analysis failed for $${token.symbol}: ${error.message}`);

            if (error.status === 401 || error.message.includes('API key')) {
                logger.error('[xAI Grok] FATAL: Invalid API Key. Please check config.');
                // Don't exit process, just stop analysis
            }
            return null;
        }
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
            ? `Tweets:\n${tweets.slice(0, 20).map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')}`
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

    /**
     * POST-SNIPE ANALYSIS
     * Diagnostic review after mechanical alert.
     */
    async analyzePostSnipe(token: TokenSnapshot, tweets: string[] = []): Promise<{
        momentumPhase: string;
        priceContext: string;
        riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
        explanation: string[];
        socialSummary: string;
        score: number; // Additive Score (0-30)
    } | null> {

        const tweetSection = tweets.length > 0
            ? `SOCIAL SENTIMENT (RAW TWEETS):\n${tweets.slice(0, 20).map(t => `- ${t.replace(/\n/g, ' ').substring(0, 100)}...`).join('\n')}`
            : `SOCIAL SENTIMENT: No Data Available due to rate limits or newness.`;

        const systemPrompt = `
You are a highly skeptical Crypto Auditor (xAI Grok).
Analyze this token for a "Sniper Bot" alert system.

CONTEXT:
- The token has already passed a basic technical filter (Market Cap, Liquidity, etc.).
- Your job is the FINAL QUALITY GATE.
- You must award an "Additive Score" (0-30 points) based on COMMUNITY VIBE and SAFETY.

STRICT RULES:
1. **BE SKEPTICAL**: Assume everything is a rug/scam until proven otherwise.
2. **FILTER SPAM**: If tweets are just "LFG", "Moon", or bot spam -> Score 0.
3. **VALUE REAL HYPE**: If tweets discuss mechanics, team, or specific alpha -> Score High.
4. **NO HYPE**: If there are NO tweets or empty profile -> Score 0.
5. **DANGEROUS NAMES**: If name contains "Peg", "Deriv", "Inu" (generic copycats) -> Penalty (Low Score).

SCORING GUIDE (0 - 30):
- **0-5**: Generic spam, no tweets, or obvious copycat. (FADE)
- **6-15**: Some activity, but looks like paid bots or very early. (WATCH)
- **16-25**: Real humans engaging, narrative forming. (GOOD)
- **26-30**: Tier-1 Alpha, KOLs mentioned, specific utility or viral meme potential. (APE)

TOKEN SNAPSHOT:
- Symbol: ${token.symbol}
- Chain: Base
- Market Cap (USD): $${token.marketCapUsd?.toLocaleString() || '0'}
- Liquidity (USD): $${token.liquidityUsd?.toLocaleString() || '0'}
- Token Age (minutes): ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) : 'N/A'}

${tweetSection}

OUTPUT FORMAT (STRICT JSON):
{
    "momentumPhase": "Early" | "Mid" | "Late" | "Exhausted",
    "priceContext": "Fresh move" | "Extended" | "Overextended",
    "riskLevel": "Low" | "Medium" | "High",
    "socialSummary": "1-2 sentence summary of what people are saying (Turkish Language)",
    "explanation": ["Bullet 1 (Technical)", "Bullet 2 (Social/Risk)", "Bullet 3 (Context)"],
    "score": number // 0-30
}
`;

        try {
            // logger.info(`[xAI] Starting Post-Snipe Analysis for ${token.symbol}...`);
            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-4-1-fast-non-reasoning",
                messages: [{ role: "system", content: systemPrompt }],
                temperature: 0.1, // Low temp for skepticism
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) return null;
            return JSON.parse(content);

        } catch (err: any) {
            logger.error(`[xAI] Post-Snipe Analysis failed: ${err.message}`);
            return null;
        }
    }
}
