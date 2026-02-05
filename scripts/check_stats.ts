
import { PostgresStorage } from '../storage/PostgresStorage';

async function main() {
    console.log('📊 Checking for high scoring tokens...');
    const storage = new PostgresStorage();
    await storage.connect();

    try {
        // Check for any token with score >= 60 in seen_tokens
        const resHighScores = await (storage as any).pool.query(`
            SELECT mint, symbol, last_score, first_seen_at 
            FROM seen_tokens 
            WHERE last_score >= 60 
            ORDER BY last_score DESC 
            LIMIT 10
        `);

        if (resHighScores.rows.length > 0) {
            console.log('\n🏆 Tokens with Score >= 60 (Last seen):');
            resHighScores.rows.forEach((row: any) => {
                const date = new Date(Number(row.first_seen_at)).toLocaleTimeString();
                console.log(`- ${row.symbol} (${row.mint}): Score ${row.last_score} @ ${date}`);
            });
        } else {
            console.log('\n❌ No tokens found with Score >= 60.');
        }

        // Check for ALERTED/TRACKING status in token_performance
        const resAlerts = await (storage as any).pool.query(`
            SELECT mint, symbol, status, alert_mc, ath_mc 
            FROM token_performance 
            ORDER BY alert_timestamp DESC 
            LIMIT 5
        `);

        if (resAlerts.rows.length > 0) {
            console.log('\n🚨 Tokens in Performance/Tracking:');
            resAlerts.rows.forEach((row: any) => {
                console.log(`- ${row.symbol} [${row.status}]: Alert MC $${Math.floor(Number(row.alert_mc) || 0)} -> ATH $${Math.floor(Number(row.ath_mc) || 0)}`);
            });
        } else {
            console.log('\n📭 Performance table is empty (No alerts fired).');
        }

    } catch (err) {
        console.error('❌ Error querying DB:', err);
    } finally {
        process.exit(0);
    }
}

main();
