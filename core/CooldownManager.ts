import { config } from '../config/env';
import { JsonStorage } from '../storage/JsonStorage';
import { SeenTokenData } from '../storage/JsonStorage';

export class CooldownManager {
    private alertTimestamps: number[] = []; // for global rate limit (in-memory is fine for this V1.1)

    constructor(private storage: JsonStorage) { }

    /**
     * Check if we can alert for this token
     */
    canAlert(tokenMint: string): { allowed: boolean; reason?: string } {
        const now = Date.now();
        const state = this.storage.load();
        const tokenData = state.seenTokens[tokenMint];

        // 1. Global Rate Limit
        this.alertTimestamps = this.alertTimestamps.filter(t => now - t < 3600000);

        if (this.alertTimestamps.length >= config.MAX_ALERTS_PER_HOUR) {
            return { allowed: false, reason: 'Global hourly limit reached' };
        }

        // 2. Per-Token Cooldown
        if (tokenData && tokenData.lastAlertAt) {
            const minutesSince = (now - tokenData.lastAlertAt) / 60000;
            if (minutesSince < config.ALERT_COOLDOWN_MINUTES) {
                return { allowed: false, reason: `Token cooldown (${minutesSince.toFixed(1)}m < ${config.ALERT_COOLDOWN_MINUTES}m)` };
            }
        }

        return { allowed: true };
    }

    recordAlert(tokenMint: string, score: number, phase: string) {
        this.alertTimestamps.push(Date.now());

        // Persist token data
        const tokenData: SeenTokenData = {
            firstSeenAt: Date.now(), // This technically overwrites firstSeen if we don't load it, but we should:
            lastAlertAt: Date.now(),
            lastScore: score,
            lastPhase: phase
        };

        // Preserve firstSeen if exists
        const state = this.storage.load();
        if (state.seenTokens[tokenMint]) {
            tokenData.firstSeenAt = state.seenTokens[tokenMint].firstSeenAt;
        }

        this.storage.updateSeenToken(tokenMint, tokenData);
    }
}
