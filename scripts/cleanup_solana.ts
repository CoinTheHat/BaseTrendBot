import { PostgresStorage } from '../storage/PostgresStorage';
import { logger } from '../utils/Logger';

async function main() {
    console.log('🧹 Cleaning up Solana tokens to reset for Base...');
    const storage = new PostgresStorage();
    await storage.connect();

    try {
        // Option 1: Delete all tokens that DO NOT start with '0x' (Assuming Base tokens start with 0x)
        // Adjust logic if strict deletion is needed.
        // Actually, user wants to clean "autopsy report holding solana tokens". 
        // Autopsy reads from 'token_performance' and sometimes 'seen_tokens'.

        // Delete from token_performance where mint does NOT start with '0x'
        const resPerf = await (storage as any).pool.query("DELETE FROM token_performance WHERE mint NOT LIKE '0x%'");
        console.log(`✅ Deleted ${resPerf.rowCount} non-Base tokens from 'token_performance'`);

        // Delete from seen_tokens where mint does NOT start with '0x'
        const resSeen = await (storage as any).pool.query("DELETE FROM seen_tokens WHERE mint NOT LIKE '0x%'");
        console.log(`✅ Deleted ${resSeen.rowCount} non-Base tokens from 'seen_tokens'`);

    } catch (err) {
        console.error('❌ Error cleaning DB:', err);
    } finally {
        process.exit(0);
    }
}

main();
