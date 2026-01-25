import { config } from '../config/env';
import { PostgresStorage } from '../storage/PostgresStorage';

export class CooldownManager {
    private alertTimestamps: number[] = []; // for global rate limit

    constructor(private storage: PostgresStorage) { }

    /**
     * Check if we can alert for this token
     */
    async canAlert(tokenMint: string): Promise<{ allowed: boolean; reason?: string }> {
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
            if (minutesSince < config.ALERT_COOLDOWN_MINUTES) {
                return { allowed: false, reason: `Token cooldown (${minutesSince.toFixed(1)}m < ${config.ALERT_COOLDOWN_MINUTES}m)` };
            }
        }

        return { allowed: true };
    }

    async recordAlert(tokenMint: string, score: number, phase: string) {
        this.alertTimestamps.push(Date.now());

        // Get existing to preserve firstSeen
        const existing = await this.storage.getSeenToken(tokenMint);

        // Persist token data
        const tokenData = {
            firstSeenAt: existing ? existing.firstSeenAt : Date.now(),
            lastAlertAt: Date.now(),
            lastScore: score,
            lastPhase: phase
        };

        await this.storage.saveSeenToken(tokenMint, tokenData);
    }
}
