import { TokenSnapshot, MemeWatchItem, MemeMatchResult } from '../models/types';
import { MemeWatchlist } from './MemeWatchlist';

export class Matcher {
    constructor(private watchlist: MemeWatchlist) { }

    match(token: TokenSnapshot): MemeMatchResult {
        const items = this.watchlist.getWatchlist();
        const tokenName = token.name.toLowerCase();
        const tokenSymbol = token.symbol.toLowerCase();

        for (const item of items) {
            if (this.isMatch(tokenName, tokenSymbol, item)) {
                return {
                    memeMatch: true,
                    matchedMeme: item,
                    matchScore: 1 // Simple boolean match for now
                };
            }
        }

        return { memeMatch: false };
    }

    private isMatch(name: string, symbol: string, item: MemeWatchItem): boolean {
        // 1. Direct phrase match in Match
        if (name.includes(item.phrase)) return true;

        // 2. Direct phrase match in Symbol (less likely but possible)
        // Remove $ and check
        const cleanBox = symbol.replace('$', '');
        if (cleanBox.includes(item.phrase)) return true;

        // 3. Tag matching
        for (const tag of item.tags) {
            if (name.includes(tag) || cleanBox.includes(tag)) {
                return true;
            }
        }

        return false; // No match found
    }
}
