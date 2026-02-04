import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { PumpFunService } from '../services/PumpFunService';
import { BirdeyeService } from '../services/BirdeyeService';
import { Matcher } from '../core/Matcher';
import { ScoringEngine } from '../core/ScoringEngine';
import { PhaseDetector } from '../core/PhaseDetector';
import { CooldownManager } from '../core/CooldownManager';
import { NarrativeEngine } from '../narrative/NarrativeEngine';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterPublisher } from '../twitter/TwitterPublisher';
import { PostgresStorage } from '../storage/PostgresStorage';
import { TokenSnapshot } from '../models/types';
import { QueryBuilder } from '../twitter/QueryBuilder';
import { TwitterScraper } from '../twitter/TwitterScraper';
import { TwitterStoryEngine } from '../narrative/TwitterStoryEngine';
import { TrendCollector } from '../trends/TrendCollector';
import { TrendTokenMatcher } from '../core/TrendTokenMatcher';
import { AlphaSearchService } from '../twitter/AlphaSearchService';
import { DexScreenerService } from '../services/DexScreenerService';
import { LLMService } from '../services/LLMService';

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private scraper = new TwitterScraper();
    private storyEngine = new TwitterStoryEngine();
    // SMART CACHE: TTL Support
    private processedCache = new Map<string, { blockedUntil: number | null, reason: string }>();

    // RETRY SETTINGS (Time in ms)
    private static CACHE_TTL: Record<string, number | null> = {
        'Too Young': 15 * 60 * 1000,           // 15 mins
        'Weak Score': 20 * 60 * 1000,          // 20 mins
        'Low Liq Ratio': 30 * 60 * 1000,       // 30 mins
        'Birdeye API Fail': 5 * 60 * 1000,     // 5 mins
        'RugCheck Failed': 10 * 60 * 1000,     // 10 mins
        // Others are Permanent (null)
    };

    private getTTL(reason: string): number | null {
        if (reason.includes('Too Young')) return TokenScanJob.CACHE_TTL['Too Young']!;
        if (reason.includes('Weak Score')) return TokenScanJob.CACHE_TTL['Weak Score']!;
        if (reason.includes('Low Liq Ratio')) return TokenScanJob.CACHE_TTL['Low Liq Ratio']!;
        if (reason.includes('Birdeye API Fail')) return TokenScanJob.CACHE_TTL['Birdeye API Fail']!;
        if (reason.includes('RugCheck')) return TokenScanJob.CACHE_TTL['RugCheck Failed']!;
        return null; // Permanent
    }

    private cleanupExpiredCache() {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [mint, data] of this.processedCache.entries()) {
            if (data.blockedUntil && data.blockedUntil < now) {
                this.processedCache.delete(mint);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            logger.info(`[Cache] 🧹 Cleaned ${cleanedCount} expired entries (Ready for retry)`);
        }
    }

    constructor(
        private pumpFun: PumpFunService,
        private birdeye: BirdeyeService,
        private dexScreener: DexScreenerService,
        private matcher: Matcher,
        private scorer: ScoringEngine,
        private phaseDetector: PhaseDetector,
        private cooldown: CooldownManager,
        private narrative: NarrativeEngine,
        private bot: ScandexBot,
        private twitter: TwitterPublisher,
        private storage: PostgresStorage,
        private trendCollector: TrendCollector,
        private trendMatcher: TrendTokenMatcher,
        private alphaSearch: AlphaSearchService,
        private llmService: any // Need to inject LLMService or use global if not injected (Assuming injected or Import)
    ) { }

    // --- AI QUEUE LOGIC ---
    private analysisQueue: Array<{ token: TokenSnapshot; msgId: number }> = [];
    private activeAnalysisCount = 0;
    private MAX_CONCURRENT_ANALYSIS = 2;

    private async enqueueAnalysis(token: TokenSnapshot, msgId: number) {
        this.analysisQueue.push({ token, msgId });
        this.processAnalysisQueue();
    }

    private async processAnalysisQueue() {
        if (this.activeAnalysisCount >= this.MAX_CONCURRENT_ANALYSIS || this.analysisQueue.length === 0) return;

        const item = this.analysisQueue.shift();
        if (!item) return;

        this.activeAnalysisCount++;
        try {
            // logger.info(`[AI Worker] Analyzing ${item.token.symbol}... (Queue: ${this.analysisQueue.length})`);

            // 1. Run Analysis
            // Note: We need access to LLMService. If not in constructor, we might need to import it or pass it.
            // Assuming we added it to constructor or have access. Ideally constructor injection.
            // For now, let's assume `this.llmService` exists. **WAIT**, I need to add it to Constructor!

            // Temporary Fix: If LLMService is not in constructor, I'll use a direct import if possible, 
            // BUT proper way is Constructor injection. I will update Constructor in next tool call.
            // For this Replace block, I will assume `this.llmService` is available.

            const analysis = await this.llmService.analyzePostSnipe(item.token);

            if (analysis) {
                // 2. Reply to Telegram (DISABLED by User Request - Background Save Only)
                /*
                const emoji = analysis.riskLevel === 'LOW' ? '🟢' : analysis.riskLevel === 'MEDIUM' ? '🟡' : '🔴';
                const replyText = `🧠 **AI ANALYST INSIGHT**\n\n` +
                    `📊 **Momentum:** ${analysis.momentumPhase}\n` +
                    `⚖️ **Price Context:** ${analysis.priceContext}\n` +
                    `🛡️ **Risk Level:** ${emoji} ${analysis.riskLevel}\n\n` +
                    `📝 *${analysis.explanation[0]}*\n` +
                    (analysis.explanation[1] ? `📝 *${analysis.explanation[1]}*` : '');
    
                await this.bot.replyToMessage(config.TELEGRAM_CHAT_ID as any, item.msgId, replyText);
                */

                // 3. Save Analysis Update to DB (Background)
                logger.info(`[AI Worker] 🧠 Saving Analysis for ${item.token.symbol} (Silent Mode)`);
                await this.storage.updateStoredAnalysis(item.token.mint, JSON.stringify(analysis));
            }

        } catch (err) {
            logger.error(`[AI Worker] Failed for ${item.token.symbol}: ${err}`);
        } finally {
            this.activeAnalysisCount--;
            // Process next
            setTimeout(() => this.processAnalysisQueue(), 100);
        }
    }

    private async runLoop() {
        if (!this.isRunning) return;

        // Parallel Processes:
        // 1. Main Scan (New Tokens) - Every SCAN_INTERVAL
        // 2. Dip Monitor (Waiting Tokens) - Every 30 seconds (User Request)

        this.runCycle().finally(() => {
            const delay = config.SCAN_INTERVAL_SECONDS * 1000;
            logger.info(`[Job] Scan complete. Next scan in ${config.SCAN_INTERVAL_SECONDS}s...`);
            setTimeout(() => this.runLoop(), delay);
        });
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`[Job] Token Scan Job started. Interval: ${config.SCAN_INTERVAL_SECONDS}s`);

        // Start Main Loop
        this.runLoop();

        // Start Dip Monitor Loop (Independent)
        this.runDipMonitor();
    }

    private async runDipMonitor() {
        if (!this.isRunning) return;

        try {
            await this.monitorDipCandidates();
        } catch (err) {
            logger.error(`[DipMonitor] Error: ${err}`);
        }

        // Run every 30 seconds
        setTimeout(() => this.runDipMonitor(), 30000);
    }

    // ... (runCycle method remains here)

    private async runCycle() {
        if (this.isScanning) {
            logger.warn(`[Job] ⚠️ Cycle skipped - Previous cycle still running.`);
            return;
        }

        // Cache Maintenance
        this.cleanupExpiredCache();

        this.isScanning = true;

        try {
            logger.info('[Job] 🔍 Starting DexScreener Scan...');

            // 1. Fetch Candidates (DexScreener Latest Pairs)
            const dexTokens = await this.dexScreener.getLatestPairs();
            logger.info(`[Fetch] 📡 Received ${dexTokens.length} tokens from DexScreener`);

            if (dexTokens.length === 0) {
                logger.info(`[Scan] ⚠️ No trending tokens from DexScreener. Cooldown may be active.`);
                return;
            }

            const freshCandidates: TokenSnapshot[] = [];
            const now = Date.now();
            let cachedCount = 0;
            let retryCount = 0;

            for (const token of dexTokens) {
                const cacheData = this.processedCache.get(token.mint);

                if (cacheData) {
                    // 1. Permanent Block?
                    if (cacheData.blockedUntil === null) {
                        cachedCount++;
                        continue;
                    }
                    // 2. TTL Not Expired?
                    if (now < cacheData.blockedUntil) {
                        cachedCount++;
                        continue;
                    }
                    // 3. TTL Expired -> Allow Retry!
                    retryCount++;
                    this.processedCache.delete(token.mint); // Remove from cache to re-process
                    logger.info(`[Cache] ♻️ Retry allowed for ${token.symbol} (${cacheData.reason} expired)`);
                }

                freshCandidates.push(token);
            }

            logger.info(`[Cache] 🔄 Filtered ${cachedCount} seen tokens. Retrying ${retryCount} expired tokens.`);

            if (freshCandidates.length === 0) {
                logger.info(`[Scan] ⚠️ No fresh candidates to process. Next cycle in 120s.`);
                return;
            }

            logger.info(`[Job] 🔍 Processing ${freshCandidates.length} candidates...`);

            // Scan Statistics
            let gateCount = 0; // Hard Rejects (Liq, Fake Pump)
            let weakCount = 0; // Low Score (<70)
            let alertCount = 0;
            const rejectionReasons: Record<string, number> = {};

            // Helper to handle rejection with TTL
            const handleRejection = (token: TokenSnapshot, reason: string) => {
                rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;

                const ttl = this.getTTL(reason);
                const blockedUntil = ttl === null ? null : Date.now() + ttl;

                this.processedCache.set(token.mint, {
                    reason,
                    blockedUntil
                });

                // Detailed Log for Retries
                if (blockedUntil) {
                    const mins = Math.ceil(ttl! / 60000);
                    logger.info(`[REJECT] ${token.symbol} -> ${reason} (Retry in ${mins}m)`);
                } else {
                    logger.info(`[REJECT] ${token.symbol} -> ${reason} (Permanent)`);
                }
            };

            // Process in chunks
            const chunks = this.chunkArray(freshCandidates, 2);

            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (token) => {
                    try {
                        // LRU Safety Check
                        if (this.processedCache.size > 1000) {
                            const oldest = this.processedCache.keys().next().value;
                            if (oldest) this.processedCache.delete(oldest);
                        }

                        // Mark as currently processing (Short TTL in case of crash)
                        // If it passes, we will update or remove this? 
                        // Actually, if it passes, we don't add to processedCache yet? 
                        // NO, we MUST add to processedCache to avoid double processing in next cycle if it takes long.
                        // Let's set a temporary "Processing" state.
                        // For simplicity, we only cache REJECTIONS. Passed tokens are handled by "seen_tokens" DB check potentially?
                        // Wait, previous logic was: processedCache.set(token.mint, Date.now()) -> Permanent block.
                        // So if we pass, we should also cache it to avoid reprocessing.
                        // Passed tokens: Permanent Block (until restart?) or maybe 1 hour?
                        // Let's stick to simple: If passed, cached as "Processed" (Permanent for this session).

                        // NOTE: We only cache rejections via handleRejection.
                        // If we don't cache here, it might be processed again immediately?
                        // Yes, so we need initial cache.

                        // Initial Cache: Block for 5 mins (Processing)
                        this.processedCache.set(token.mint, { blockedUntil: Date.now() + 5 * 60000, reason: 'Processing' });

                        // --- STEP 1: STRICT LIQUIDITY GATES (Sniper Firewall) ---

                        const liq = Number(token.liquidityUsd) || 0;
                        const mc = Number(token.marketCapUsd) || 0;
                        const liqMcRatio = mc > 0 ? liq / mc : 0;
                        const ageMins = token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) : 0;

                        // GATE 0: BLACKLIST (HARD BLOCK - BEFORE EVERYTHING)
                        const BLACKLIST = ['pedo', 'child', 'nazi', 'jew', 'hitler', 'rape', 'terrorist', 'kill'];
                        const tokenText = (token.name + ' ' + token.symbol).toLowerCase();
                        if (BLACKLIST.some(word => tokenText.includes(word))) {
                            logger.warn(`[Gate] ⛔ BLACKLIST: ${token.symbol} contains banned word`);
                            gateCount++;
                            handleRejection(token, 'BLACKLIST');
                            logger.info(`[REJECT] ${token.symbol} -> BLACKLIST`);
                            return;
                        }

                        // GATE A: Unplayable Liquidity
                        if (liq < 5000) {
                            gateCount++;
                            handleRejection(token, 'Low Liquidity (<$5k)');
                            logger.info(`[REJECT] ${token.symbol} -> Low Liquidity ($${Math.floor(liq)})`);
                            return;
                        }

                        // GATE B: Rug / Scam Risk
                        // > 90%: Likely HoneyPot (Dev adds all liq)
                        // < 15%: Unstable / Slippage Hell
                        if (liqMcRatio > 0.90) {
                            gateCount++;
                            logger.warn(`[Gate] 🚫 High Liquidity Ratio: ${token.symbol} (${(liqMcRatio * 100).toFixed(1)}%). Potential Scam.`);
                            handleRejection(token, 'High Liq Ratio (>90%)');
                            logger.info(`[REJECT] ${token.symbol} -> High Liq Ratio (${(liqMcRatio * 100).toFixed(0)}%)`);
                            return;
                        }
                        // NUANCED LIQ RATIO: Combine percentage with absolute liquidity
                        if (liqMcRatio < 0.05) {
                            // <5%: Always reject (extreme volatility)
                            gateCount++;
                            handleRejection(token, 'Liq Ratio <5% (Extreme)');
                            logger.info(`[REJECT] ${token.symbol} -> Liq Ratio <5% (${(liqMcRatio * 100).toFixed(1)}%)`);
                            return;
                        }
                        if (liqMcRatio >= 0.05 && liqMcRatio < 0.10 && liq < 20000) {
                            // 5-10% + low absolute liquidity: Reject
                            gateCount++;
                            handleRejection(token, 'Low Liq Ratio + Low Absolute Liq');
                            logger.info(`[REJECT] ${token.symbol} -> Liq ${(liqMcRatio * 100).toFixed(1)}% + $${Math.floor(liq / 1000)}k`);
                            return;
                        }
                        // 5-10% + $20k+ liquidity: Pass
                        // >10%: Pass

                        // GATE C: Age Filter (The "Golden Window")
                        // 20 mins to 24 Hours (Softened)
                        if (ageMins < 20) {
                            // logger.debug(`[Gate] 👶 Too Young: ${token.symbol} (${ageMins}m)`);
                            gateCount++;
                            handleRejection(token, 'Too Young (<20m)');
                            logger.info(`[REJECT] ${token.symbol} -> Too Young (${ageMins}m)`);
                            return;
                        }
                        if (ageMins > 1440) { // 24 Hours
                            // logger.debug(`[Gate] 👴 Too Old: ${token.symbol} (${ageMins}m)`);
                            gateCount++;
                            handleRejection(token, 'Too Old (>24h)');
                            logger.info(`[REJECT] ${token.symbol} -> Too Old (${ageMins}m)`);
                            return;
                        }

                        // --- STEP 2: MECHANICAL SCORING (Speed Focus) ---
                        const matchResult = { memeMatch: false };
                        let enrichedToken = token; // Mutable for enrichment

                        const scoreRes = this.scorer.score(enrichedToken, matchResult);
                        const { totalScore, phase } = scoreRes;

                        // REJECTION CHECK
                        // Threshold: 70/100
                        if (phase === 'REJECTED_RISK') {
                            gateCount++; // Fake pump or other hard risk from engine
                            handleRejection(token, 'Risk Engine (Fake Pump)');
                            logger.info(`[REJECT] ${token.symbol} -> Risk Engine (Fake Pump/Dump)`);
                            return;
                        }

                        if (totalScore < 60) {
                            weakCount++;
                            handleRejection(token, 'Weak Score');
                            logger.info(`[REJECT] ${token.symbol} -> Weak Score (${totalScore}/60)`);
                            return;
                        }






                        // GATE D: RUGCHECK (API) - STRICT SECURITY
                        // Only check if passed previous gates to save requests
                        if (totalScore >= 70) {
                            const rugCheck = await this.checkRugSecurity(token.mint);
                            if (!rugCheck.safe) {
                                logger.warn(`[Gate] 🔒 RugCheck Failed: ${token.symbol} (${rugCheck.reason})`);
                                gateCount++;
                                handleRejection(token, 'RugCheck Failed');
                                logger.info(`[REJECT] ${token.symbol} -> RugCheck (${rugCheck.reason})`);
                                return;
                            }
                        }

                        // --- STEP 2.5: SECURITY & HOLDER CHECK (API Cost Saver - only high scores) ---
                        // Only fetch for potential gems to save API calls
                        try {
                            // Pass price/MC for DexScreener supply fallback
                            const sec = await this.birdeye.getTokenSecurity(token.mint, {
                                priceUsd: token.priceUsd || 0,
                                marketCapUsd: token.marketCapUsd || 0
                            });
                            enrichedToken.holderCount = sec.holderCount;
                            enrichedToken.top10HoldersSupply = sec.top10Percent;

                            // GATE E: Whale Trap / Bot Activity
                            if (sec.top10Percent > 50) {
                                logger.info(`[Gate] 🐋 Whale Risk: ${token.symbol} (Top 10: ${sec.top10Percent.toFixed(1)}%)`);
                                gateCount++;
                                handleRejection(token, 'Whale Risk (Top10 >50%)');
                                logger.info(`[REJECT] ${token.symbol} -> Whale Risk (${sec.top10Percent.toFixed(0)}%)`);
                                return;
                            }
                            if (sec.holderCount < 50) {
                                logger.info(`[Gate] 🤖 Bot Risk: ${token.symbol} (Holders: ${sec.holderCount})`);
                                gateCount++;
                                handleRejection(token, 'Bot Risk (Holders <50)');
                                logger.info(`[REJECT] ${token.symbol} -> Bot Risk (${sec.holderCount} Holders)`);
                                return;
                            }
                        } catch (secErr: any) {
                            // ENHANCED FAIL-SAFE: Distinguish between API errors and missing supply
                            const errorMsg = secErr.message || '';

                            if (errorMsg.includes('supply/metrics missing')) {
                                // Very new token - Birdeye hasn't indexed supply yet
                                // Skip holder check but allow token to proceed
                                logger.info(`[Birdeye] Supply data missing for ${token.symbol} (Very new token). Skipping holder check.`);
                                enrichedToken.holderCount = 0; // Unknown
                                enrichedToken.top10HoldersSupply = 0; // Unknown
                                // Continue to next checks (don't return/reject)
                            } else {
                                // Real API error (404, 429, auth issue, etc.)
                                logger.warn(`[Birdeye] Failed to fetch holders: ${secErr}. REJECTING for safety.`);
                                gateCount++;
                                handleRejection(token, 'Birdeye API Fail');
                                return; // FAIL-SAFE: Reject if we can't verify holder data
                            }
                        }

                        // --- STEP 3: SNIPED! (Immediate Alert) ---
                        const { allowed } = await this.cooldown.canAlert(token.mint);
                        if (allowed) {
                            alertCount++;

                            // Determine Segment for Logging
                            let segmentLog = 'UNKNOWN';
                            if (mc < 50000) segmentLog = 'SEED';
                            else if (mc < 250000) segmentLog = 'GOLDEN';
                            else segmentLog = 'RUNNER';

                            logger.info(`🔫 [SNIPED] [${segmentLog}] ${token.symbol} Score: ${totalScore}/100 | Liq: $${Math.floor(liq)} | MC: $${Math.floor(mc)}`);

                            // --- 🧠 AI SYNTHESIS (User Request: Contextual Analysis) ---
                            // 1. Fetch Tweets
                            let tweetContext: string[] = [];
                            try {
                                logger.info(`[Scan] 🐦 Fetching Twitter context for $${token.symbol}...`);
                                const alphaResult = await this.alphaSearch.checkAlpha(token.symbol);
                                tweetContext = alphaResult.tweets;
                            } catch (e) {
                                logger.warn(`[Scan] ⚠️ Failed to fetch tweets: ${e}`);
                            }

                            // 2. Run AI Analysis
                            let aiAnalysis: any = null;
                            try {
                                aiAnalysis = await this.llmService.analyzePostSnipe(enrichedToken, tweetContext);
                            } catch (e) {
                                logger.warn(`[Scan] ⚠️ AI Analysis failed: ${e}`);
                            }

                            // Create Narrative (Enriched with AI)
                            const displayScore = (totalScore / 10).toFixed(1);
                            const aiSummary = aiAnalysis?.socialSummary ? `\n\n🧠 **AI VIBE:**\n${aiAnalysis.socialSummary}` : '';
                            const riskBadge = aiAnalysis?.riskLevel ? ` • Risk: ${aiAnalysis.riskLevel}` : '';

                            const mechanicalNarrative = {
                                headline: `🔫 SNIPER ALERT: ${token.symbol} ${riskBadge}`,
                                narrativeText: `⚡ **MECHANICAL ENTRY** • Score: ${displayScore}/10
🚀 **MOMENTUM SIGNAL**
• Txns Accelerating
• Liquidity Healthy ($${(liq / 1000).toFixed(1)}k)
• MC Segment: ${segmentLog}${aiSummary}

⚠️ **RISK CHECK:**
• Volatility: High
• Entry Type: ${segmentLog === 'SEED' ? 'Small Size' : 'Full Size'}
• Phase: ${aiAnalysis?.momentumPhase || 'Unknown'}`,
                                dataSection: `• MC: $${(mc / 1000).toFixed(1)}k
• Liq: $${(liq / 1000).toFixed(1)}k
• Vol: $${(token.volume5mUsd || 0).toFixed(0)}
• Age: ${token.createdAt ? Math.floor((Date.now() - token.createdAt.getTime()) / 60000) + 'm' : 'N/A'}`,
                                tradeLens: `SNIPE`,
                                vibeCheck: aiAnalysis?.riskLevel ? `Risk: ${aiAnalysis.riskLevel}` : `MECHANICAL`,
                                aiScore: totalScore,
                                aiApproved: true
                            };

                            // Save as ALERTED immediately
                            await this.storage.saveSeenToken(token.mint, {
                                symbol: token.symbol,
                                firstSeenAt: Date.now(),
                                lastAlertAt: Date.now(),
                                lastScore: totalScore,
                                lastPhase: 'ALERTED',
                                storedAnalysis: JSON.stringify(mechanicalNarrative),
                                rawSnapshot: enrichedToken
                            });

                            // ⚡ FIRE ALERT & GET MSG ID
                            const alertMsgId = await this.bot.sendAlert(mechanicalNarrative, enrichedToken, scoreRes);

                            await this.cooldown.recordAlert(token.mint, totalScore, 'TRACKING', token.priceUsd);

                            // AUTOPSY PRESERVATION
                            await this.storage.savePerformance({
                                mint: token.mint,
                                symbol: token.symbol,
                                alertMc: mc,
                                athMc: mc,
                                currentMc: mc,
                                entryPrice: Number(token.priceUsd) || 0,
                                status: 'TRACKING',
                                alertTimestamp: new Date(),
                                lastUpdated: new Date()
                            });

                        }

                    } catch (tokenErr) {
                        logger.error(`[Job] Error processing token ${token.symbol}: ${tokenErr}`);
                    }
                }));
                // Tiny delay between chunks
                await new Promise(r => setTimeout(r, 50));
            }



            // SCAN SUMMARY
            const totalRejected = gateCount + weakCount;
            const rejectionBreakdown = Object.entries(rejectionReasons)
                .sort((a, b) => b[1] - a[1]) // Sort by count descending
                .map(([reason, count]) => `   • ${reason}: ${count}`)
                .join('\n');

            logger.info(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 [SCAN SUMMARY]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Total Fetched: ${dexTokens.length}
🔄 Cached (4h): ${cachedCount}
🎯 Fresh Processed: ${freshCandidates.length}

🛑 REJECTED (${totalRejected}):
  ⛔ GATE (Liq/Risk): ${gateCount}
${rejectionBreakdown}
  📉 WEAK (Score <70): ${weakCount}

✅ SNIPED: ${alertCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        } catch (err) {
            logger.error(`[Job] Cycle failed: ${err}`);
        } finally {
            this.isScanning = false;
        }
    }


    /**
     * RUGCHECK API INTEGRATION (FAIL-SAFE)
     * Timeout: 3s
     */
    private async checkRugSecurity(mint: string): Promise<{ safe: boolean; reason?: string }> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000); // 3s Hard Timeout

            // Use axios with signal if supported, or raw fetch (Node 18+)
            const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!response.ok) {
                return { safe: false, reason: 'RugCheck API Error' };
            }

            const data: any = await response.json();

            // 0. Ensure RugCheck has indexed this token
            if (!data.tokenMeta) {
                return { safe: false, reason: 'Token not indexed by RugCheck yet' };
            }

            // 1. Mint Authority (Must be null/renounced)
            if (data.tokenMeta.mintAuthority) {
                return { safe: false, reason: 'Mint Authority Not Renounced' };
            }

            // 2. Freeze Authority (Must be null)
            if (data.tokenMeta?.freezeAuthority) {
                return { safe: false, reason: 'Freeze Authority Enabled' };
            }

            // 3. LP Lock Check (STRICT: >= 90%)
            const markets = data.markets || [];
            if (markets.length === 0) {
                return { safe: false, reason: 'No LP Market Found' };
            }

            const isLpSafe = markets.some((m: any) => {
                const lp = m.lp || {};
                // lpLocked or lpBurned should be >= 90%
                return (lp.lpLocked >= 90 || lp.lpBurned >= 90);
            });

            if (!isLpSafe) {
                return { safe: false, reason: 'LP Not Locked/Burned (< 90%)' };
            }

            return { safe: true };

        } catch (err) {
            return { safe: false, reason: 'RugCheck Timeout/Failed' };
        }
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        const res: T[][] = [];
        for (let i = 0; i < arr.length; i += size) { res.push(arr.slice(i, i + size)); }
        return res;
    }

    /**
     * RAPID MONITOR: Checks 'WAITING_DIP' tokens every 30s.
     * Uses cached analysis + fresh price to alert instantly on dip.
     */
    private async monitorDipCandidates() {
        // 1. Get Waiting Tokens
        const candidates = await this.storage.getWaitingForDipTokens();
        if (candidates.length === 0) return;

        logger.info(`[DipMonitor] 👀 Watching ${candidates.length} tokens for entry...`);

        // 2. Fetch Live Prices (Bulk)
        const mints = candidates.map(c => c.mint);
        const liveTokens = await this.dexScreener.getTokens(mints);

        // 3. Compare & Alert
        for (const candidate of candidates) {
            const liveToken = liveTokens.find(t => t.mint === candidate.mint);

            // TIMEOUT CHECK (>60 Mins)
            const waitDuration = Date.now() - new Date(candidate.alertTimestamp).getTime();
            if (waitDuration > 60 * 60 * 1000) {
                logger.info(`[DipMonitor] ⌛ Timeout for ${candidate.symbol}. Missed Dip.`);
                await this.storage.failDipToken(candidate.mint, 'MISSED_DIP');
                continue;
            }

            if (!liveToken) continue;

            const currentMc = liveToken.marketCapUsd || 0;
            const targetMc = candidate.dipTargetMc || 0;

            // ENTRY CONDITION: Price <= Target
            if (currentMc > 0 && currentMc <= targetMc) {
                logger.info(`[DipMonitor] 🎯 DIP HIT! ${candidate.symbol} dropped to $${Math.floor(currentMc)} (Target: $${Math.floor(targetMc)})`);

                // Retrieve Stored Analysis
                const seenData = await this.storage.getSeenToken(candidate.mint);
                let narrative = null;

                if (seenData?.storedAnalysis) {
                    try {
                        narrative = JSON.parse(seenData.storedAnalysis);
                        narrative.dataSection =
                            `• MC: $${(currentMc).toLocaleString()}\n` +
                            `• Liq: $${(liveToken.liquidityUsd ?? 0).toLocaleString()}\n` +
                            `• Vol (24h): $${(liveToken.volume24hUsd ?? 0).toLocaleString()}\n` +
                            `• Age: ${liveToken.createdAt ? Math.floor((Date.now() - liveToken.createdAt.getTime()) / (3600 * 1000)) + 'h' : 'N/A'}\n` +
                            `• ✅ Dip Entry Triggered (Price dropped 50% from pump)`;

                    } catch (e) {
                        logger.error(`[DipMonitor] Failed to parse stored analysis for ${candidate.symbol}`);
                    }
                }

                if (!narrative) {
                    narrative = {
                        headline: `📉 DIP ENTRY TRIGGERED`,
                        narrativeText: `Dip Entry Triggered`,
                        dataSection: `• MC: $${(currentMc).toLocaleString()}\n• Target: $${(targetMc).toLocaleString()}`,
                        tradeLens: `WAITING -> TRACKING`,
                        vibeCheck: `Requires Manual Review`,
                        aiScore: seenData?.lastScore || 7,
                        aiApproved: true
                    };
                }

                if (narrative) {
                    await this.bot.sendTokenAlert(liveToken, narrative, `CORRECTION ENTRY: $${candidate.symbol} 📉`);
                    await this.storage.activateDipToken(candidate.mint, liveToken.priceUsd || 0, currentMc);
                    await this.cooldown.recordAlert(liveToken.mint, seenData?.lastScore || 7, 'TRACKING', liveToken.priceUsd);
                }
            }
        }
    }
}
