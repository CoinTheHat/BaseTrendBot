import { TokenSnapshot, MemeWatchItem, MemeMatchResult } from '../models/types';
import { MemeWatchlist } from './MemeWatchlist';

export class Matcher {
    constructor(private watchlist: MemeWatchlist) { }

    getWatchlistItems(): MemeWatchItem[] {
        return this.watchlist.getWatchlist();
    }

    match(token: TokenSnapshot): MemeMatchResult {
        const items = this.watchlist.getWatchlist();
        const tokenName = token.name.toLowerCase();
        const tokenSymbol = token.symbol.toLowerCase();

        for (const item of items) {
            if (this.isMatch(tokenName, tokenSymbol, item, token.mint)) {
                return {
                    memeMatch: true,
                    matchedMeme: item,
                    matchScore: 1 // Simple boolean match for now
                };
            }
        }

        return { memeMatch: false };
    }

    private isMatch(name: string, symbol: string, item: MemeWatchItem, mint: string): boolean {
        // 0. Contract Address Match (Exact Case)
        if (mint === item.phrase) return true;

        // Prepare keywords for text matching
        const phraseLower = item.phrase.toLowerCase();

        // 1. Direct phrase match in Match (Case Insensitive)
        if (name.includes(phraseLower)) return true;

        // 2. Direct phrase match in Symbol (Case Insensitive)
        // Remove $ and check
        const cleanBox = symbol.replace('$', '');
        if (cleanBox.includes(phraseLower)) return true;

        // 3. Tag matching (Case Insensitive)
        for (const tag of item.tags) {
            const tagLower = tag.toLowerCase();
            if (name.includes(tagLower) || cleanBox.includes(tagLower)) {
                return true;
            }
        }

        return false; // No match found
    }
}
