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

        // Deduplicate
        return Array.from(new Set(queries)).slice(0, 3); // Max 3 queries to save time
    }
}
