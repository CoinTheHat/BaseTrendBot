import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage'; // Assuming this exports the class
import { logger } from '../utils/Logger';
import fs from 'fs';
import path from 'path';

const storage = new PostgresStorage();

async function main() {
    await storage.connect();
    const tokens = await storage.getAllPerformanceTokens();

    // --- STATISTICS CALCULATION ---
    const total = tokens.length;
    let strategy1Wins = 0; // Split (1.5x / 2.5x)
    let strategy2Wins = 0; // Moonshot (2x)
    let strategy3Wins = 0; // 30m Time-Limit (Using mc_30m)
    let hybrid1Wins = 0; // Hybrid Split
    let hybrid2Wins = 0; // Hybrid Moonshot

    // PnL Simulators
    const STRAT_BET = 100;
    let strat1Pnl = 0;
    let strat2Pnl = 0;
    let strat3Pnl = 0;
    let hybrid1Pnl = 0;
    let hybrid2Pnl = 0;

    const topPerformers = [];

    for (const t of tokens) {
        const entryMc = t.alertMc || 1;
        const athMc = t.athMc || entryMc;
        const mc30 = t.mc30m || 0;
        const maxMc30 = t.maxMc30m || 0;

        const mult = athMc / entryMc;
        const mult30Close = mc30 / entryMc;
        const mult30Max = maxMc30 / entryMc;

        // Top Performer Check
        topPerformers.push({ symbol: t.symbol, mult, pnl: 0 }); // Update PnL later? No, just Mult.

        // --- Strat 1: Split (Unlimited) ---
        let s1 = 0;
        if (mult >= 2.5) { s1 = 100; strategy1Wins++; }
        else if (mult >= 1.5) { s1 = 25; strategy1Wins++; }
        else s1 = -100;
        strat1Pnl += s1;

        // --- Strat 2: Moonshot (Unlimited) ---
        let s2 = 0;
        if (mult >= 2.0) { s2 = 100; strategy2Wins++; }
        else s2 = -100;
        strat2Pnl += s2;

        // --- Strat 3: 30m Blind Exit ---
        let s3 = 0;
        if (mc30 > 0) {
            const exitVal = (mc30 / entryMc) * STRAT_BET;
            s3 = exitVal - STRAT_BET;
            if (s3 > 0) strategy3Wins++;
        } else {
            s3 = -100; // No data = Loss
        }
        strat3Pnl += s3;

        // --- Hybrid 1: Split (30m Limit) ---
        let h1 = 0;
        if (maxMc30 > 0 && mc30 > 0) {
            if (mult30Max >= 2.5) { h1 = 100; hybrid1Wins++; } // Hit within 30m
            else if (mult30Max >= 1.5) { h1 = 25; hybrid1Wins++; } // Hit TP1
            else h1 = ((mc30 / entryMc) * STRAT_BET) - STRAT_BET; // Missed, Sell at 30m
        } else { h1 = -100; }
        hybrid1Pnl += h1;

        // --- Hybrid 2: Moonshot (30m Limit) ---
        let h2 = 0;
        if (maxMc30 > 0 && mc30 > 0) {
            if (mult30Max >= 2.0) { h2 = 100; hybrid2Wins++; } // Hit within 30m
            else h2 = ((mc30 / entryMc) * STRAT_BET) - STRAT_BET; // Missed, Sell at 30m
        } else { h2 = -100; }
        hybrid2Pnl += h2;
    }

    // Sort Top Performers
    topPerformers.sort((a, b) => b.mult - a.mult);
    const top5 = topPerformers.slice(0, 5);

    // --- REPORT GENERATION ---
    const reportContent = `
# 🧠 AI Strategy Analysis Report
**Generated at:** ${new Date().toISOString()}
**Total Tokens Analyzed:** ${total}

---

## 📊 Strategy Performance Summary

| Strategy | PnL ($) | Win Rate | ROI |
| :--- | :---: | :---: | :---: |
| **1. The Split (Unlimited)** | **$${Math.floor(strat1Pnl)}** | ${((strategy1Wins / total) * 100).toFixed(1)}% | ${(strat1Pnl / (total * 100) * 100).toFixed(1)}% |
| **2. Moonshot (Unlimited)** | **$${Math.floor(strat2Pnl)}** | ${((strategy2Wins / total) * 100).toFixed(1)}% | ${(strat2Pnl / (total * 100) * 100).toFixed(1)}% |
| **3. 30-Minute Blind Exit** | **$${Math.floor(strat3Pnl)}** | ${Math.floor(strategy3Wins)} wins | ${(strat3Pnl / (total * 100) * 100).toFixed(1)}% |
| **4. Hybrid Split (30m Limit)** | **$${Math.floor(hybrid1Pnl)}** | - | ${(hybrid1Pnl / (total * 100) * 100).toFixed(1)}% |
| **5. Hybrid Moonshot (30m Limit)** | **$${Math.floor(hybrid2Pnl)}** | - | ${(hybrid2Pnl / (total * 100) * 100).toFixed(1)}% |

> *Note: Hybrid strategies assume a forced sell at 30m if targets are not met. Missing data counts as -100% loss.*

---

## 🏆 Top Performers (ATH Multiplier)
${top5.map((t, i) => `${i + 1}. **${t.symbol}**: ${t.mult.toFixed(2)}x`).join('\n')}

---

## 📝 AI Analyst Insight
Based on the data collected from ${total} signals:

1.  **Risk Profile:** The **${strat1Pnl > strat2Pnl ? 'Split Strategy (Conservation)' : 'Moonshot Strategy (Aggression)'}** yielded better results in the unlimited timeframe. This suggests that ${strat1Pnl > strat2Pnl ? 'securing early profits is crucial in this volatile market.' : 'tokens that pump tend to pump hard, justifying the "all-or-nothing" approach.'}
    
2.  **Time Sensitivity:** Comparing the Unlimited vs. 30-Minute Hybrid strategies, holding longer than 30 minutes ${hybrid1Pnl > strat1Pnl ? 'was NOT worth the risk. Quick scalps proved superior.' : 'was often necessary to realize the full potential of moonshots.'}

3.  **Recommendation:**
    *   **Best Approach:** Strategy ${strat1Pnl >= strat2Pnl && strat1Pnl >= hybrid1Pnl ? '1 (Split/Unlimited)' : strat2Pnl >= hybrid2Pnl ? '2 (Moonshot/Unlimited)' : 'Hybrid (Time-Bounded)'} seems optimal currently.
    *   **Focus:** Look for tokens showing strength in the first 30 minutes, but don't be afraid to ${hybrid1Pnl > strat1Pnl ? 'cut losers fast.' : 'let winners ride beyond the initial volatility.'}

---
*End of Report*
`;

    const outputPath = path.join(process.cwd(), 'analysis_report.md');
    fs.writeFileSync(outputPath, reportContent);
    console.log(`Report generated at: ${outputPath}`);

    process.exit(0);
}

main().catch(console.error);
