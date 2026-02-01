
import { PostgresStorage } from '../storage/PostgresStorage';

async function main() {
    console.log("🧹 Cleaning up Unknown tokens...");
    const storage = new PostgresStorage();
    await storage.connect();

    // Access pool directly (using any cast to bypass private access for script)
    const pool = (storage as any).pool;

    const res = await pool.query(`DELETE FROM seen_tokens WHERE symbol IS NULL OR symbol = ''`);
    console.log(`✅ Deleted ${res.rowCount} unknown/empty symbol records.`);

    process.exit(0);
}

main();
