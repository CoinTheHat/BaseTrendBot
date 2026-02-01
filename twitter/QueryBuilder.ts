export class QueryBuilder {
    static build(name: string, symbol: string, mint: string): string[] {
        const cleanName = name.trim();
        const cleanSymbol = symbol.trim().toUpperCase();
        const queries: string[] = [];

        // Tier 1: Cashtag (Strongest Signal)
        // Only if symbol is distinctive enough (>= 3 chars)
        if (cleanSymbol.length >= 3) {
            queries.push(`$${cleanSymbol}`);
        }

        // Tier 2: Name + "solana" (Context specific)
        queries.push(`"${cleanName}" solana`);

        // Tier 3: Symbol + "solana" (Backup if cashtag is shadowed)
        queries.push(`${cleanSymbol} solana`);

        // Tier 4: Contract Address (Last Resort - precise but maybe 0 tweets)
        if (mint) {
            queries.push(mint.slice(0, 8)); // Search first 8 chars of CA
        }

        // Filter duplicates and return
        return [...new Set(queries)];
    }
}
