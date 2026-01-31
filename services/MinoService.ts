import axios from 'axios';
import { logger } from '../utils/Logger';
import { DexScreenerService } from './DexScreenerService';
import { TokenSnapshot } from '../models/types';

export class MinoService {
    private apiKey: string;
    private baseUrl = 'https://mino.ai/v1/automation/run-sse'; // Veya run-sync

    constructor(private dexScreener: DexScreenerService) {
        this.apiKey = process.env.MINO_API_KEY || '';
        if (!this.apiKey) {
            logger.warn('⚠️ MINO_API_KEY is missing! Fallback to standard scraping.');
        }
    }

    async fetchNewPairsFromDexScreener(): Promise<TokenSnapshot[]> {
        if (!this.apiKey) return [];

        try {
            logger.info('🤖 Mino AI Agent is extracting data from DexScreener...');

            const response = await axios.post(
                this.baseUrl,
                {
                    url: "https://dexscreener.com/solana/new-pairs",
                    goal: "Extract first 20 tokens with Symbol, Name, Address, Liquidity. Return valid JSON.",
                    mode: "stealth" // Bu çok önemli! Cloudflare'i geçen mod.
                },
                {
                    headers: {
                        'X-API-Key': this.apiKey,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000 // AI biraz düşünebilir, süre tanıyalım.
                }
            );

            // Mino'nun döndüğü veriyi işle
            const data = response.data;
            if (data && data.resultJson && data.resultJson.tokens) {
                logger.info(`✅ Mino returned ${data.resultJson.tokens.length} tokens.`);

                // Extract Mints
                const tokens = data.resultJson.tokens;
                const mints: string[] = tokens
                    .map((t: any) => t.Address || t.address || t.contractAddress || t.ContractAddress)
                    .filter((m: string) => typeof m === 'string' && m.length > 30); // Basic Solana address check

                if (mints.length > 0) {
                    logger.info(`[Mino] Hydrating ${mints.length} valid mints via DexScreener API...`);
                    return await this.dexScreener.getTokens(mints);
                } else {
                    logger.warn(`[Mino] No valid mints found in AI response.`);
                }
            } else {
                logger.warn(`[Mino] Invalid response format or no tokens found.`);
            }

            return [];

        } catch (error: any) {
            logger.error(`❌ Mino API Error: ${error.message}`);
            return [];
        }
    }
}
