export class QueryBuilder {
    static build(name: string, symbol: string): string[] {
        const queries: string[] = [];
        const cleanName = name.trim();
        const cleanSymbol = symbol.trim().toUpperCase();

        // 1. CashTag
        queries.push(`$${cleanSymbol}`);

        // 2. Name + Solana (if name is distinctive)
        if (cleanName.split(' ').length < 4) {
            queries.push(`"${cleanName}" solana`);
            queries.push(`"${cleanName}" coin`);
        }

        // 3. Symbol + Solana (if symbol is not generic like 'SOL')
        if (cleanSymbol !== 'SOL' && cleanSymbol.length > 2) {
            queries.push(`${cleanSymbol} solana`);
        }

        // 4. Fallback: Broader for distinctive names
        if (cleanName.length > 4 && !cleanName.includes(' ')) {
            queries.push(`"${cleanName}" crypto`);
        }

        // 5. Fallback: Broader for distinctive symbols (4+ chars)
        if (cleanSymbol.length >= 4) {
            queries.push(`$${cleanSymbol} crypto`);
        }

        // Deduplicate
        return Array.from(new Set(queries)).slice(0, 3); // Max 3 queries to save time
    }
}
