import { config } from '../config/env';
import { logger } from '../utils/Logger';
import { CooldownManager } from '../core/CooldownManager';
import { NarrativeEngine } from '../narrative/NarrativeEngine';
import { ScandexBot } from '../telegram/TelegramBot';
import { TwitterPublisher } from '../twitter/TwitterPublisher';
import { PostgresStorage } from '../storage/PostgresStorage';
import { TokenSnapshot } from '../models/types';
import { AlphaSearchService } from '../twitter/AlphaSearchService';
import { DexScreenerService } from '../services/DexScreenerService';
import { GoPlusService } from '../services/GoPlusService';
import { LLMService } from '../services/LLMService';

// Gem Hunter v3.0 Imports
import { applyHardFilters } from '../core/SecurityFilter';
import { MaturationService } from '../services/MaturationService';
import { calculateTechnicalScore } from '../core/TechnicalScorer';
import { AITwitterScorer } from '../services/AITwitterScorer';
import { calculateFinalScore } from '../core/FinalScorer';
import { TelegramNotifier } from '../telegram/TelegramNotifier';
import { detectFakePump } from '../core/FakePumpDetector';

export class TokenScanJob {
    private isRunning = false;
    private isScanning = false;
    private maturationService: MaturationService;
    private aiTwitterScorer: AITwitterScorer;

    // SMART CACHE: TTL Support
    private processedCache = new Map<string, { blockedUntil: number | null, reason: string }>();

    constructor(
        private dexScreener: DexScreenerService,
        private cooldown: CooldownManager,
        private narrative: NarrativeEngine,
        private bot: ScandexBot,
        private twitter: TwitterPublisher,
        private storage: PostgresStorage,
        private alphaSearch: AlphaSearchService,
        private llmService: LLMService,
        private goPlus: GoPlusService
    ) {
        this.maturationService = new MaturationService(storage);
        this.aiTwitterScorer = new AITwitterScorer(llmService);
    }

    private getTTL(reason: string, token: TokenSnapshot): number | null {
        if (reason.includes('TOO_YOUNG')) return 5 * 60 * 1000;
        if (reason.includes('LIQUIDITY_TOO_LOW')) return 10 * 60 * 1000;
        if (reason.includes('MC_TOO_LOW')) return 10 * 60 * 1000;
        if (reason.includes('NOT_ENOUGH_HOLDERS')) return 10 * 60 * 1000;
        if (reason.includes('WAITING_FOR_MATURATION')) return 5 * 60 * 1000;
        return null; // Permanent for others
    }

    private cleanupExpiredCache() {
        const now = Date.now();
        for (const [mint, data] of this.processedCache.entries()) {
            if (data.blockedUntil && data.blockedUntil < now) {
                this.processedCache.delete(mint);
            }
        }
    }

    private async runLoop() {
        if (!this.isRunning) return;
        this.runCycle().finally(() => {
            const delay = config.SCAN_INTERVAL_SECONDS * 1000;
            setTimeout(() => this.runLoop(), delay);
        });
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`[Job] Gem Hunter v3.0 Job started. Interval: ${config.SCAN_INTERVAL_SECONDS}s`);
        this.runLoop();
    }

    private async runCycle() {
        if (this.isScanning) return;
        this.isScanning = true;
        this.cleanupExpiredCache();

        try {
            logger.info('[Job] 🔍 Gem Hunter v3.0: Scanning DexScreener...');
            const candidates = await this.dexScreener.getLatestPairs();
            const uniqueTokens = Array.from(new Map(candidates.map(t => [t.mint, t])).values());

            if (uniqueTokens.length === 0) return;

            for (const token of uniqueTokens) {
                try {
                    // Cache Check
                    const cache = this.processedCache.get(token.mint);
                    if (cache && (!cache.blockedUntil || cache.blockedUntil > Date.now())) continue;

                    // PHASE 1: BASIC FILTERS (Age, MC, Liq)
                    const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 9999; // Default to old if missing to prevent 0m/TOO_YOUNG
                    const liqUsd = token.liquidityUsd || 0;
                    const mcUsd = token.marketCapUsd || 0;

                    if (ageMins < 20) {
                        logger.info(`[Phase 1] ❌ REJECTED: ${token.symbol} | Reason: TOO_YOUNG (${ageMins.toFixed(0)}m) | MC: $${(mcUsd / 1000).toFixed(1)}k | Liq: $${(liqUsd / 1000).toFixed(1)}k`);
                        this.processedCache.set(token.mint, { reason: 'TOO_YOUNG', blockedUntil: Date.now() + 5 * 60 * 1000 });
                        continue;
                    }
                    if (ageMins > 1440) {
                        logger.info(`[Phase 1] ❌ REJECTED: ${token.symbol} | Reason: TOO_OLD (${(ageMins / 60).toFixed(1)}h) | MC: $${(mcUsd / 1000).toFixed(1)}k | Liq: $${(liqUsd / 1000).toFixed(1)}k`);
                        this.processedCache.set(token.mint, { reason: 'TOO_OLD', blockedUntil: null });
                        continue;
                    }
                    if (liqUsd < 5000 || mcUsd < 10000) {
                        logger.info(`[Phase 1] ❌ REJECTED: ${token.symbol} | Reason: LOW_LIQ_OR_MC | MC: $${(mcUsd / 1000).toFixed(1)}k | Liq: $${(liqUsd / 1000).toFixed(1)}k`);
                        this.processedCache.set(token.mint, { reason: 'LOW_LIQ_MC', blockedUntil: Date.now() + 10 * 60 * 1000 });
                        continue;
                    }

                    // FETCH INTERNAL DETAILS (Holders, LP Locks)
                    const pairAddress = token.pairAddress;
                    if (pairAddress) {
                        logger.info(`[Job] 🔍 Fetching details for candidate: ${token.symbol}...`);
                        const details = await this.dexScreener.getPairDetails(pairAddress);
                        if (details) {
                            token.holderCount = details.holderCount;
                            token.lpLockedPercent = details.liquidity.totalLockedPercent;
                            token.lpBurned = details.liquidity.burnedPercent >= 90;
                            token.top10HoldersSupply = details.top10Percent;
                            token.isMintable = details.security.isMintable;
                            token.isFreezable = details.security.isFreezable;
                            token.isCTO = details.isCTO;
                        }
                    }

                    // PHASE 1: DETAILED HARD FILTERS (Rug Risk, Whale)
                    const hardResult = applyHardFilters(token);
                    if (!hardResult.passed) {
                        logger.info(`[Phase 1] ❌ REJECTED: ${token.symbol} | Reason: ${hardResult.reason}`);
                        const ttl = this.getTTL(hardResult.reason || '', token);
                        this.processedCache.set(token.mint, {
                            reason: hardResult.reason || 'HARD_FILTER',
                            blockedUntil: ttl ? Date.now() + ttl : null
                        });
                        continue;
                    }

                    // PHASE 1: MATURATION LOGIC
                    const maturation = await this.maturationService.checkMaturation(token);
                    if (maturation.status === 'FAILED') {
                        this.processedCache.set(token.mint, { reason: 'MATURATION_FAILED', blockedUntil: null });
                        continue;
                    }
                    if (maturation.status === 'WAITING') continue;

                    if (maturation.status === 'PASSED_EARLY') {
                        logger.info(`[Maturation] 🔥 EARLY APE candidate: ${token.symbol} (Age: ${token.createdAt ? ((Date.now() - new Date(token.createdAt).getTime()) / 60000).toFixed(0) : '?'}m)`);
                    } else if (maturation.status === 'PASSED_VERIFIED') {
                        const growthInfo = maturation.growth !== undefined ? ` (Growth: ${maturation.growth.toFixed(1)}%)` : '';
                        logger.info(`[Maturation] 💎 VERIFIED GEM candidate: ${token.symbol}${growthInfo}`);
                    }

                    logger.info(`[Job] ✅ ${token.symbol} passed Phase 1. Moving to Phase 2...`);

                    // PHASE 2: FAKE PUMP DETECTION
                    const fakePump = detectFakePump(token);
                    if (fakePump.detected) {
                        logger.info(`[Test] 🚫 FAKE PUMP detected for ${token.symbol}: ${fakePump.reason}`);
                        this.processedCache.set(token.mint, { reason: 'FAKE_PUMP', blockedUntil: null });
                        continue;
                    }

                    // PHASE 2: TECHNICAL SCORING
                    const techScore = calculateTechnicalScore(token);
                    logger.info(`[Phase 2] ✅ Technical Score: ${techScore.total.toFixed(0)}/40 (MC:${techScore.mcScore} Liq:${techScore.liquidityScore} Dist:${techScore.distributionScore} SEC:${techScore.securityScore} Age:${techScore.ageScore})`);

                    // EXTRA: GoPlus Security 
                    const goplus = await this.checkRugSecurity(token.mint);
                    if (!goplus.safe) {
                        this.processedCache.set(token.mint, { reason: `GOPLUS_${goplus.reason}`, blockedUntil: null });
                        continue;
                    }

                    // PHASE 3: AI TWITTER SCORING
                    let tweets: string[] = [];
                    const twitterUrl = token.links.twitter;

                    if (twitterUrl || maturation.status === 'PASSED_VERIFIED') {
                        logger.info(`[Phase 3] 🐦 searching Twitter for ${token.symbol}...`);
                        const alphaResult = await this.alphaSearch.checkAlpha(token.symbol, token.mint);
                        tweets = alphaResult.tweets || [];
                    }

                    const aiScore = await this.aiTwitterScorer.calculateAIScore(token, tweets);
                    logger.info(`[Phase 3] ✅ Social Score: ${aiScore.total.toFixed(0)}/60 (Organic:${aiScore.organicRateScore} Diversity:${aiScore.authorDiversityScore} Narr:${aiScore.narrativeScore} Comm:${aiScore.communityScore} RugPenalty:${aiScore.rugRiskPenalty}) | Verdict: ${aiScore.verdict}`);

                    // AI Gate Check (v6)
                    if (aiScore.verdict === 'AI_GATE_FAILED') {
                        logger.info(`[AI Gate] ⏳ ${token.symbol} failed gate, retry in 30m`);
                        this.cooldown.recordAIGateFailure(token.mint);
                        this.processedCache.set(token.mint, {
                            reason: 'AI_GATE_FAILED',
                            blockedUntil: Date.now() + 30 * 60 * 1000
                        });
                        continue;
                    }

                    // PHASE 4: FINAL SCORING
                    const finalScoreResult = calculateFinalScore(token, techScore, aiScore, maturation);

                    if (finalScoreResult.category === 'FADE') {
                        logger.info(`[Score] ❌ FADED: ${token.symbol} | Score: ${finalScoreResult.finalScore.toFixed(0)} | Verdict: ${finalScoreResult.verdict}`);
                        this.processedCache.set(token.mint, {
                            reason: 'WEAK_SCORE',
                            blockedUntil: Date.now() + 15 * 60 * 1000
                        });
                        continue;
                    }

                    // COOLDOWN & DUPLICATION CHECK
                    const { allowed, reason } = await this.cooldown.canAlert(token.mint, finalScoreResult.finalScore);
                    if (!allowed) {
                        logger.info(`[Cooldown] ${token.symbol} blocked: ${reason}`);
                        continue;
                    }

                    // SUCCESS! SEND ALERT
                    logger.info(`[Phase 4] 🚀 GEM FOUND: ${token.symbol} | Score: ${finalScoreResult.finalScore.toFixed(0)}/100 | Category: ${finalScoreResult.category}`);

                    const message = TelegramNotifier.formatTokenMessage(token, finalScoreResult, aiScore.details, maturation.growth);
                    await this.bot.sendRawAlert(message);

                    // Record & Save
                    await this.cooldown.recordAlert(token.mint, finalScoreResult.finalScore, 'ALERTED', token.priceUsd);
                    await this.storage.saveSeenToken(token.mint, {
                        symbol: token.symbol,
                        firstSeenAt: Date.now(),
                        lastAlertAt: Date.now(),
                        lastScore: finalScoreResult.finalScore,
                        lastPhase: finalScoreResult.category,
                        storedAnalysis: JSON.stringify({ finalScore: finalScoreResult, aiScore }),
                        rawSnapshot: token
                    });

                    // Cache to prevent re-alerts for 4 hours
                    this.processedCache.set(token.mint, { reason: 'ALERTED', blockedUntil: Date.now() + (4 * 60 * 60 * 1000) });

                } catch (tokenErr) {
                    logger.error(`[Job] Error processing ${token.symbol}: ${tokenErr}`);
                }
            }
        } catch (err) {
            logger.error(`[Job] Cycle failed: ${err}`);
        } finally {
            this.isScanning = false;
        }
    }

    private async checkRugSecurity(mint: string): Promise<{ safe: boolean; reason?: string }> {
        try {
            const security = await this.goPlus.checkSecurity(mint);
            if (!security.isSafe) {
                return { safe: false, reason: security.dangerReason || 'UNSAFE' };
            }
            return { safe: true };
        } catch (err) {
            return { safe: false, reason: 'GOPLUS_ERROR' };
        }
    }

    private chunkArray<T>(arr: T[], size: number): T[][] {
        return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
            arr.slice(i * size, i * size + size)
        );
    }
}
