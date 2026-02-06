import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';

const storage = new PostgresStorage();

async function main() {
    await storage.connect();

    console.log('🔍 Checking tokens that were CLOSE to passing filters...\n');

    // Get all seen tokens from last 24h
    const query = `
        SELECT 
            symbol,
            mint,
            last_score,
            last_phase,
            stored_analysis,
            raw_snapshot
        FROM seen_tokens
        WHERE first_seen_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000
        ORDER BY last_score DESC NULLS LAST
        LIMIT 50
    `;

    const result = await storage['pool'].query(query);

    if (result.rows.length === 0) {
        console.log('❌ No tokens found in last 24h.');
        process.exit(0);
    }

    console.log(`📊 Found ${result.rows.length} tokens. Analyzing close calls...\n`);

    const closeCalls: any[] = [];

    for (const row of result.rows) {
        const { symbol, mint, last_score, last_phase, raw_snapshot } = row;

        // Parse raw snapshot if available
        let holderCount = 0;
        let top10 = 0;
        let liq = 0;
        let mc = 0;

        if (raw_snapshot) {
            holderCount = raw_snapshot.holderCount || 0;
            top10 = raw_snapshot.top10HoldersSupply || 0;
            liq = Number(raw_snapshot.liquidityUsd) || 0;
            mc = Number(raw_snapshot.marketCapUsd) || 0;
        }

        // Check if it's a "close call"
        const isCloseCall = (
            (last_score >= 55 && last_score < 60) || // Score just below threshold
            (holderCount >= 45 && holderCount < 50) || // Holder count close
            (top10 > 45 && top10 <= 50) || // Top 10 just safe
            (last_phase === 'REJECTED_RISK' || last_phase === 'WEAK_SCORE')
        );

        if (isCloseCall) {
            closeCalls.push({
                symbol,
                mint: mint.substring(0, 12) + '...',
                score: last_score || 'N/A',
                holders: holderCount,
                top10: top10.toFixed(1),
                liq: Math.floor(liq / 1000) + 'k',
                mc: Math.floor(mc / 1000) + 'k',
                phase: last_phase
            });
        }
    }

    if (closeCalls.length === 0) {
        console.log('✅ No tokens were close to passing. Filters are either:\n   • TOO STRICT (nothing comes close)\n   • WELL CALIBRATED (all rejects are clear fails)\n');
    } else {
        console.log(`🎯 CLOSE CALLS (${closeCalls.length}):\n`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Symbol       | Score | Holders | Top10% | Liq   | MC    | Phase');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        closeCalls.forEach(t => {
            const sym = t.symbol.padEnd(12);
            const score = String(t.score).padEnd(5);
            const holders = String(t.holders).padEnd(7);
            const top10 = String(t.top10 + '%').padEnd(6);
            const liq = t.liq.padEnd(5);
            const mc = t.mc.padEnd(5);
            console.log(`${sym} | ${score} | ${holders} | ${top10} | ${liq} | ${mc} | ${t.phase}`);
        });
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Summary
        const avgScore = closeCalls.filter(t => t.score !== 'N/A').reduce((sum, t) => sum + Number(t.score), 0) / closeCalls.filter(t => t.score !== 'N/A').length;
        const avgHolders = closeCalls.reduce((sum, t) => sum + t.holders, 0) / closeCalls.length;

        console.log(`📈 INSIGHTS:`);
        console.log(`   • Average Score of Close Calls: ${avgScore.toFixed(1)}/100`);
        console.log(`   • Average Holder Count: ${Math.floor(avgHolders)}`);
        console.log(`   • Recommendation: ${avgScore > 57 ? '⚠️ Consider lowering score threshold to 55' : '✅ Filters seem balanced'}`);
    }

    process.exit(0);
}

main().catch(console.error);
