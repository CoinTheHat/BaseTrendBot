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

    async fetchNewPairsFromDexScreener(chain: 'solana' | 'base'): Promise<TokenSnapshot[]> {
        if (!this.apiKey) return [];

        const targetUrl = chain === 'base'
            ? "https://dexscreener.com/base/new-pairs"
            : "https://dexscreener.com/solana/new-pairs";

        const goalPrompt = chain === 'base'
            ? "Extract first 20 tokens with Symbol, Name, Address, Liquidity. For Base, ensure addresses start with 0x. Return valid JSON."
            : "Extract first 20 tokens with Symbol, Name, Address, Liquidity. Return valid JSON.";

        try {
            logger.info(`🤖 Mino AI Agent is extracting data from DexScreener (${chain})...`);

            const response = await axios.post(
                this.baseUrl,
                {
                    url: targetUrl,
                    goal: goalPrompt,
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
                logger.info(`✅ Mino returned ${data.resultJson.tokens.length} tokens for ${chain}.`);

                // Extract Mints
                const tokens = data.resultJson.tokens;
                const mints: string[] = tokens
                    .map((t: any) => t.Address || t.address || t.contractAddress || t.ContractAddress)
                    .filter((m: string) => {
                        if (!m || typeof m !== 'string') return false;
                        if (chain === 'base') return m.startsWith('0x') && m.length > 40;
                        return m.length > 30; // Solana check
                    });

                if (mints.length > 0) {
                    logger.info(`[Mino] Hydrating ${mints.length} valid ${chain} mints via DexScreener API...`);
                    // DexScreener supports both Solana and Base addresses in the same endpoint /tokens/{address}
                    return await this.dexScreener.getTokens(mints);
                } else {
                    logger.warn(`[Mino] No valid mints found in AI response for ${chain}.`);
                }
            } else {
                logger.warn(`[Mino] Invalid response format or no tokens found for ${chain}.`);
            }

            return [];

        } catch (error: any) {
            logger.error(`❌ Mino API Error: ${error.message}`);
            return [];
        }
    }
}
