import { config } from '../config/env';
import { PostgresStorage } from '../storage/PostgresStorage';

export class CooldownManager {
    private alertTimestamps: number[] = []; // for global rate limit

    constructor(private storage: PostgresStorage) { }

    /**
     * Check if we can alert for this token
     */
    async canAlert(tokenMint: string, currentScore: number, customCooldownMinutes?: number): Promise<{ allowed: boolean; reason?: string }> {
        const now = Date.now();

        // 1. Global Rate Limit
        this.alertTimestamps = this.alertTimestamps.filter(t => now - t < 3600000); // 1 hour

        if (this.alertTimestamps.length >= config.MAX_ALERTS_PER_HOUR) {
            return { allowed: false, reason: 'Global hourly limit reached' };
        }

        // 2. Per-Token Cooldown (From DB)
        const tokenData = await this.storage.getSeenToken(tokenMint);

        if (tokenData && tokenData.lastAlertAt) {
            const minutesSince = (now - tokenData.lastAlertAt) / 60000;

            // STRICT RULE: 2 Hours Cooldown (120m)
            const STRICT_COOLDOWN = 120;

            if (minutesSince < STRICT_COOLDOWN) {
                return { allowed: false, reason: `Strict Cooldown (${minutesSince.toFixed(1)}m < 2h)` };
            }

            // RE-ALERT SCORE THRESHOLD RULE:
            // If checking for a 2nd time (re-entry), score MUST be > 80 (Superior).
            if (currentScore < 80) {
                return { allowed: false, reason: `Re-Alert Score too low (${currentScore} < 80)` };
            }
        }

        return { allowed: true };
    }

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
