export class QueryBuilder {
    static build(name: string, symbol: string): string[] {
        const cleanName = name.trim();
        const cleanSymbol = symbol.trim().toUpperCase();

        // 1. Single Shot Logic
        // If Symbol >= 4 chars (e.g. $BONK, $PEPE) -> Use Cashtag
        if (cleanSymbol.length >= 4) {
            return [`$${cleanSymbol}`];
        }

        // Else (short/generic) -> Use "Name" solana
        return [`"${cleanName}" solana`];
    }
}
