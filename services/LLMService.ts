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
            logger.info(`[xAI Grok] Analyzing $${token.symbol} with ${config.XAI_MODEL || 'grok-2-latest'}...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-2-latest", // Cost optimized model
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
                logger.error('[xAI Grok] FATAL: Invalid API Key. Stopping bot.');
                process.exit(1);
            }
            return null;
        }
    }

    private buildPrompt(token: TokenSnapshot, tweets: string[], hasTweets: boolean): { systemPrompt: string; userContent: string } {
        // ... (Prompt logic remains mostly same, just optimized for Grok)
        const systemPrompt = `
Sen Kıdemli bir Kripto Degen Analistisin (xAI Grok tabanlı). Görevin, piyasa verilerine ve son tweetlere dayanarak Solana meme tokenlarını analiz etmek.
Eleştirel ol, şüpheci yaklaş ama potansiyeli yüksek fırsatlara açık ol. Asla jenerik cevaplar verme.

**Giriş Verileri:**
- Sembol: ${token.symbol}
- Fiyat: $${token.priceUsd}
- Likidite: $${token.liquidityUsd}
- Market Cap: $${token.marketCapUsd}
- Hacim (5dk): $${token.volume5mUsd}
- Top 10 Holder: ${token.top10HoldersSupply ? token.top10HoldersSupply.toFixed(2) + '%' : 'Bilinmiyor'}

**Görev:**
JSON formatında derinlemesine ve yapılandırılmış bir analiz sun. TÜM ÇIKTILAR %100 TÜRKÇE OLMALIDIR.

**Analiz Gereksinimleri:**
1. **Analist Özeti**: Bu token neden radarımızda? (2-3 cümle ile özetle)
2. **Teknik Görünüm**: Likidite/MC oranını analiz et. Hacim organik mi? Likidite, piyasa değerini destekliyor mu?
3. **Sosyal Vibe**: Tweetler bot gibi mi yoksa gerçek bir topluluk mu var? Kimler konuşuyor?
4. **Risk Analizi**: Eğer Top 10 Holder oranı %30'un üzerindeyse "YÜKSEK BALİNA RİSKİ" uyarısı ver. Rug pull ihtimalini değerlendir.
5. **Strateji**: Net bir aksiyon öner (Örn: "Düşüşü bekle", "Ufak bir miktar gir", "Uzak dur").
6. **Puan (0-10)**:
   - 0-4: Çöp / Rug Riski
   - 5-6: İzleme Listesi (Metrikler iyi ama henüz sessiz)
   - 7-8: Potansiyel Gem (İyi hacim + aktif sosyal)
   - 9-10: Güçlü Alım (Hype + Likidite + Trend fırtınası)

**JSON Çıktı Formatı (KESİN):**
{
    "headline": "Kısa ve Çarpıcı Başlık",
    "narrative": "Tokenin ruhunu anlatan genel açıklama.",
    "analystSummary": "Analistin Türkçe özeti...",
    "technicalOutlook": "Teknik görünüm yorumu...",
    "socialVibe": "Sosyal ortam yorumu...",
    "riskAnalysis": "Risk analizi detayları...",
    "strategy": "Strateji önerisi...",
    "analysis": ["Madde 1", "Madde 2"],
    "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "DANGEROUS",
    "riskReason": "Kısa risk nedeni",
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

    async analyzeTrendBatch(tweetsInput: string[], sourceIds: string[]): Promise<any[]> {
        if (tweetsInput.length === 0) return [];

        const systemPrompt = `
Sen Uzman Bir Kripto Trend Avcısısın. Görevin, sana verilen tweet yığınını tarayıp, aralarındaki "ELMAS" (Gem) projeleri bulmak.
Konu: ERC-8004 ve Yeni Hibrit Token Standartları.

**Elmek İstediklerin (ÇÖP):**
- Spam, Airdrop, Giveaway postları.
- Anlamsız hype, sadece "$TK ticker" yazıp geçen botlar.
- Tekrar eden içerikler.

**Aramak İstediklerin (ELMAS):**
- Somut bir teknoloji veya proje anlatanlar.
- Yeni bir kontrat adresi (CA) paylaşıp teknik detay verenler.
- Topluluk tarafından ciddi ilgi gören (Like/RT yüksek) ve organik duranlar.

Sana verilen metin formatı: "[ID] Tweet İçeriği"

**Çıktı Formatı (JSON Array):**
Eğer kayda değer hiçbir şey yoksa BOŞ ARRAY [] dön.
Eğer varsa:
[
  {
    "projectName": "Proje Adı veya Ticker",
    "summary": "Neden bu proje önemli? (Tek cümle, Türkçe)",
    "sourceTweetId": "İlgili tweetin ID'si (Metinden al)",
    "confidenceScore": 85
  }
]
`;

        // Combine tweets into a single text block
        const userContent = tweetsInput.map((text, idx) => `[${sourceIds[idx]}] ${text.replace(/\n/g, ' ')}`).join('\n\n');

        try {
            logger.info(`[xAI Grok] Batch analyzing ${tweetsInput.length} tweets...`);

            const completion = await this.xai.chat.completions.create({
                model: config.XAI_MODEL || "grok-2-latest",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.1, // Very strict
                response_format: { type: "json_object" }
            });

            const content = completion.choices[0].message.content;
            if (!content) return [];

            const parsed = JSON.parse(content);
            // Handle wrapper object if any (e.g. { "projects": [...] }) or direct array
            const projects = Array.isArray(parsed) ? parsed : (parsed.projects || parsed.gems || []);

            return projects;
        } catch (err) {
            logger.error(`[xAI Batch] Analysis failed: ${err}`);
            return [];
        }
    }
}
