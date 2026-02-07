import { TokenSnapshot } from '../models/types';
import { PostgresStorage } from '../storage/PostgresStorage';
import { logger } from '../utils/Logger';

export type MaturationStatus = "WAITING" | "PASSED_EARLY" | "PASSED_VERIFIED" | "FAILED";

export interface MaturationResult {
    status: MaturationStatus;
    viralBonus: boolean;
    viralMultiplier: number;
    growth?: number;
}

/**
 * PHASE 1: MATURATION LOGIC (45-Minute Growth Test)
 */
export class MaturationService {
    constructor(private storage: PostgresStorage) { }

    async checkMaturation(token: TokenSnapshot): Promise<MaturationResult> {
        const ageMins = token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / (60 * 1000) : 0;
        const holders = token.holderCount || 0;
        const mc = token.marketCapUsd || 0;

        // 1. EARLY APE (20-45m)
        // Logic: Pass if hard filters pass. Technical score adjustment handled in pipeline.
        if (ageMins >= 20 && ageMins < 45) {
            const existing = await this.storage.getMaturationRecord(token.mint);

            if (!existing) {
                await this.storage.saveMaturationRecord({
                    address: token.mint,
                    initialHolders: holders,
                    initialMC: mc
                });
                logger.info(`[Maturation] 🐣 Registered EARLY APE candidate: ${token.symbol} (Holders: ${holders})`);
            }

            return { status: "PASSED_EARLY", viralBonus: false, viralMultiplier: 1.0 };
        }

        // 2. VERIFIED GEM (45m+)
        if (ageMins >= 45) {
            const record = await this.storage.getMaturationRecord(token.mint);

            if (!record) {
                // If no record exists, we likely missed the 20-45m window.
                // We allow it to pass as VERIFIED GEM without growth bonus.
                return { status: "PASSED_VERIFIED", viralBonus: false, viralMultiplier: 1.0 };
            }

            if (record.status === "FAILED") {
                return { status: "FAILED", viralBonus: false, viralMultiplier: 1.0 };
            }

            // Calculate growth from the initial snapshot
            const initialHolders = record.initialHolders || 1;
            const holderGrowth = ((holders - initialHolders) / initialHolders) * 100;

            let viralBonus = false;
            let viralMultiplier = 1.0;

            // %5+ growth required to pass
            if (holderGrowth < 5) {
                await this.storage.updateMaturationStatus(token.mint, "FAILED");
                logger.info(`[Maturation] ❌ FAILED: ${token.symbol} holder growth too low (${holderGrowth.toFixed(1)}%)`);
                return { status: "FAILED", viralBonus: false, viralMultiplier: 1.0, growth: holderGrowth };
            }

            // %15+ Viral Bonus
            if (holderGrowth >= 15) {
                viralBonus = true;
            }

            // %40+ Viral Multiplier
            if (holderGrowth >= 40) {
                viralBonus = true;
                viralMultiplier = 1.2;
            }

            await this.storage.updateMaturationStatus(token.mint, "PASSED", viralBonus, viralMultiplier);

            if (viralBonus) {
                logger.info(`[Maturation] ✨ ${token.symbol} is VIRAL! Growth: ${holderGrowth.toFixed(1)}% | Multiplier: ${viralMultiplier}x`);
            }

            return { status: "PASSED_VERIFIED", viralBonus, viralMultiplier, growth: holderGrowth };
        }

        // Too young (<20m) - handled by Hard Filters anyway
        return { status: "WAITING", viralBonus: false, viralMultiplier: 1.0 };
    }
}
