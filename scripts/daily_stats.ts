import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';

const storage = new PostgresStorage();

async function main() {
    await storage.connect();

    // Define "Today" (Start of day in local time)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfTodayMs = today.getTime();
    const startOfTodayISO = today.toISOString();

    console.log(`📅 Stats for Today: ${today.toLocaleDateString()} (Since ${startOfTodayISO})`);

    const stats = await storage.getDailyStats();

    const passRate = stats.scanned > 0 ? ((stats.passed / stats.scanned) * 100).toFixed(1) : "0.0";

    console.log(`\n📊 AI Analysis Summary:`);
    console.log(`-----------------------`);
    console.log(`🤖 Analyzed: ${stats.scanned}`);
    console.log(`✅ Passed:   ${stats.passed}`);
    console.log(`📉 Rate:     ${passRate}%`);
    console.log(`-----------------------`);

    process.exit(0);
}

main().catch(console.error);
