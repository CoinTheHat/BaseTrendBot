import 'dotenv/config';
import { Pool } from 'pg';

async function main() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL
    });

    console.log('🔗 Connecting to PostgreSQL...\n');

    try {
        // 1. Check connection
        await pool.query('SELECT NOW()');
        console.log('✅ Connected!\n');

        // 2. Get table stats
        console.log('📊 DATABASE STATS:\n');

        const tableStats = await pool.query(`
            SELECT 
                'seen_tokens' as table_name,
                COUNT(*) as total_rows
            FROM seen_tokens
            UNION ALL
            SELECT 
                'token_performance' as table_name,
                COUNT(*) as total_rows
            FROM token_performance
        `);

        tableStats.rows.forEach(row => {
            console.log(`   ${row.table_name}: ${row.total_rows} rows`);
        });

        // 3. Get recent tokens (last 7 days)
        console.log('\n🔍 RECENT TOKENS (Last 7 Days):\n');

        const recentTokens = await pool.query(`
            SELECT 
                symbol,
                mint,
                last_score,
                last_phase,
                first_seen_at,
                last_alert_at
            FROM seen_tokens
            WHERE first_seen_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000
            ORDER BY first_seen_at DESC
            LIMIT 20
        `);

        if (recentTokens.rows.length === 0) {
            console.log('   ❌ No tokens in last 7 days.');
        } else {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Symbol       | Score | Phase           | Alerted? | Mint');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            recentTokens.rows.forEach(row => {
                const sym = (row.symbol || 'Unknown').padEnd(12);
                const score = String(row.last_score || 'N/A').padEnd(5);
                const phase = (row.last_phase || 'Unknown').padEnd(15);
                const alerted = row.last_alert_at ? '✅' : '❌';
                const mint = row.mint.substring(0, 12) + '...';

                console.log(`${sym} | ${score} | ${phase} | ${alerted}       | ${mint}`);
            });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }

        // 4. Check for tokens with scores near threshold (55-65)
        console.log('🎯 CLOSE CALLS (Score 50-65):\n');

        const closeCalls = await pool.query(`
            SELECT 
                symbol,
                mint,
                last_score,
                last_phase,
                raw_snapshot
            FROM seen_tokens
            WHERE last_score BETWEEN 50 AND 65
                AND first_seen_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000
            ORDER BY last_score DESC
            LIMIT 10
        `);

        if (closeCalls.rows.length === 0) {
            console.log('   ❌ No tokens scored between 50-65 in last 7 days.');
            console.log('   ⚠️  This suggests filters might be TOO STRICT or no tokens were scanned.\n');
        } else {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Symbol       | Score | Holders | Top10% | Liq     | Phase');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            closeCalls.rows.forEach(row => {
                const sym = (row.symbol || 'Unknown').padEnd(12);
                const score = String(row.last_score).padEnd(5);

                let holders = 'N/A';
                let top10 = 'N/A';
                let liq = 'N/A';

                if (row.raw_snapshot) {
                    holders = String(row.raw_snapshot.holderCount || 0).padEnd(7);
                    top10 = String((row.raw_snapshot.top10HoldersSupply || 0).toFixed(1) + '%').padEnd(6);
                    liq = Math.floor((Number(row.raw_snapshot.liquidityUsd) || 0) / 1000) + 'k';
                    liq = liq.padEnd(7);
                }

                const phase = row.last_phase || 'Unknown';

                console.log(`${sym} | ${score} | ${holders} | ${top10} | ${liq} | ${phase}`);
            });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }

        // 5. Check token_performance for actual alerts
        console.log('🚨 ALERTED TOKENS (From token_performance):\n');

        const alertedTokens = await pool.query(`
            SELECT 
                symbol,
                mint,
                status,
                alert_mc,
                current_mc,
                alert_timestamp
            FROM token_performance
            WHERE alert_timestamp > NOW() - INTERVAL '7 days'
            ORDER BY alert_timestamp DESC
            LIMIT 10
        `);

        if (alertedTokens.rows.length === 0) {
            console.log('   ❌ No tokens alerted in last 7 days.\n');
        } else {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('Symbol       | Alert MC | Current MC | Status    | Time');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            alertedTokens.rows.forEach(row => {
                const sym = (row.symbol || 'Unknown').padEnd(12);
                const alertMc = Math.floor(row.alert_mc / 1000) + 'k';
                const currentMc = Math.floor(row.current_mc / 1000) + 'k';
                const status = row.status.padEnd(9);
                const time = new Date(row.alert_timestamp).toLocaleString('tr-TR');

                console.log(`${sym} | ${alertMc.padEnd(8)} | ${currentMc.padEnd(10)} | ${status} | ${time}`);
            });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }

    } catch (err) {
        console.error('❌ Database Error:', err);
    } finally {
        await pool.end();
    }
}

main();
