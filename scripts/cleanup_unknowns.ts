
import { PostgresStorage } from '../storage/PostgresStorage';

async function main() {
    console.log("🧹 Cleaning up Unknown tokens...");
    const storage = new PostgresStorage();
    await storage.connect();

    // Access pool directly (using any cast to bypass private access for script)
    const pool = (storage as any).pool;

    // 1. Clean seen_tokens
    const resSeen = await pool.query(`DELETE FROM seen_tokens WHERE symbol IS NULL OR symbol = '' OR symbol = 'Unknown'`);
    console.log(`✅ Deleted ${resSeen.rowCount} records from seen_tokens.`);

    // 2. Clean token_performance
    const resPerf = await pool.query(`DELETE FROM token_performance WHERE symbol IS NULL OR symbol = '' OR symbol = 'Unknown'`);
    console.log(`✅ Deleted ${resPerf.rowCount} records from token_performance.`);

    process.exit(0);
}

main();
