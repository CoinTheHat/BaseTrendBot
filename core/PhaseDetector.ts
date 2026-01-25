import { TokenSnapshot, ScoreResult } from '../models/types';
import { config } from '../config/env';

export class PhaseDetector {

    detect(token: TokenSnapshot, scoreRes: ScoreResult): "SPOTTED" | "TRACKING" | "COOKING" | "SERVED" {
        const mc = token.marketCapUsd || 0;
        const createdAt = token.createdAt ? token.createdAt.getTime() : Date.now();
        const ageMins = (Date.now() - createdAt) / 60000;

        // SERVED: Late stage
        if (mc > config.MAX_MC_USD * 3) {
            return "SERVED";
        }

        // COOKING: High MC, good score
        if (mc >= config.MAX_MC_USD || (mc > config.MAX_MC_USD * 0.8 && scoreRes.totalScore >= 8)) {
            return "COOKING";
        }

        // TRACKING: Mid range
        if (mc >= config.MIN_MC_USD && (ageMins > 10 || token.volume5mUsd! > 5000)) {
            return "TRACKING";
        }

        // SPOTTED: Early / Fresh
        return "SPOTTED";
    }
}
