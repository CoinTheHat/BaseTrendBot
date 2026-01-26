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

            // SPECIAL RULE: "Alpha" or "Early Match" alerts should be ONCE per cycle/forever to avoid spamming the same discovery.
            // If the last alert was < 24 hours ago, we block it for Alpha Hunters.
            // Let's make it configurable or just hardcode a 'Strict Mode' for re-alerts.
            // For now: Stick to config, but maybe increase it for 'Alpha' phases if passed in?
            // Actually, let's treat 'Alerted' as done for at least 30m.

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
