import { config } from '../config/env';
import { PostgresStorage } from '../storage/PostgresStorage';

/**
 * CooldownManager v6
 * Base Chain adapted from Solana v6 system
 * 
 * Cooldown Rules:
 * - İlk kez → cooldown yok (First time = no cooldown)
 * - Re-alert → 2 saat + skor +5 artış gerekli (2 hours + score +5 increase required)
 * - AI Min Gate fail → 30dk retry (30 min retry)
 */
export class CooldownManager {
    private alertTimestamps: number[] = []; // for global rate limit
    private aiGateFailedTokens: Map<string, number> = new Map(); // For AI gate retry tracking

    constructor(private storage: PostgresStorage) { }

    /**
     * Check if we can alert for this token
     * v6 Rules:
     * - First time alert: No cooldown
     * - Re-alert: 2 hours + score must increase by 5+
     * - AI Gate failed: 30 min retry
     */
    async canAlert(tokenMint: string, currentScore: number, customCooldownMinutes?: number): Promise<{ allowed: boolean; reason?: string }> {
        const now = Date.now();

        // 1. Global Rate Limit (keep existing)
        this.alertTimestamps = this.alertTimestamps.filter(t => now - t < 3600000); // 1 hour

        if (this.alertTimestamps.length >= config.MAX_ALERTS_PER_HOUR) {
            return { allowed: false, reason: 'Global hourly limit reached' };
        }

        // 2. Check AI Gate Failed Retry (v6)
        const aiGateFailedAt = this.aiGateFailedTokens.get(tokenMint);
        if (aiGateFailedAt) {
            const minsSinceFail = (now - aiGateFailedAt) / 60000;
            const AI_GATE_RETRY_MINUTES = 30;

            if (minsSinceFail < AI_GATE_RETRY_MINUTES) {
                return { allowed: false, reason: `AI Gate Retry (${minsSinceFail.toFixed(1)}m < 30m)` };
            } else {
                // Clear the AI gate failed status after 30 minutes
                this.aiGateFailedTokens.delete(tokenMint);
            }
        }

        // 3. Per-Token Cooldown (From DB)
        const tokenData = await this.storage.getSeenToken(tokenMint);

        if (tokenData && tokenData.lastAlertAt) {
            const minutesSince = (now - tokenData.lastAlertAt) / 60000;
            const lastScore = tokenData.lastScore || 0;

            // v6 COOLDOWN: 2 Hours (120 minutes)
            const STRICT_COOLDOWN = 120;

            if (minutesSince < STRICT_COOLDOWN) {
                return { allowed: false, reason: `Cooldown (${minutesSince.toFixed(1)}m < 2h)` };
            }

            // v6 RE-ALERT RULE: Score must increase by 5+
            // Only apply if this is a re-alert (has previous score)
            if (lastScore > 0) {
                const scoreIncrease = currentScore - lastScore;
                const MIN_SCORE_INCREASE = 5;

                if (scoreIncrease < MIN_SCORE_INCREASE) {
                    return { allowed: false, reason: `Re-Alert Score too low (${scoreIncrease.toFixed(0)} < +5)` };
                }
            }
        }

        return { allowed: true };
    }

    /**
     * Record a failed AI Gate attempt for retry tracking
     */
    recordAIGateFailure(tokenMint: string) {
        this.aiGateFailedTokens.set(tokenMint, Date.now());
    }

    /**
     * Record an alert
     */
    async recordAlert(tokenMint: string, score: number, phase: string, price?: number) {
        this.alertTimestamps.push(Date.now());

        // Get existing to preserve firstSeen
        const existing = await this.storage.getSeenToken(tokenMint);

        // Persist token data
        const tokenData = {
            firstSeenAt: existing ? existing.firstSeenAt : Date.now(),
            lastAlertAt: Date.now(),
            lastScore: score,
            lastPhase: phase,
            // Capture price at alert time for "Too Late" checks later
            lastPrice: price || existing?.lastPrice || 0
        };

        await this.storage.saveSeenToken(tokenMint, tokenData);
    }
}
