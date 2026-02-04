import 'dotenv/config';
import { PostgresStorage } from '../storage/PostgresStorage';
import { logger } from '../utils/Logger';
import fs from 'fs';
import path from 'path';

const storage = new PostgresStorage();

async function main() {
    await storage.connect();
    const tokens = await storage.getAllTokensWithAnalysis();

    let md = `# 🩺 DETAILED TOKEN AUTOPSY REPORT
**Generated:** ${new Date().toISOString()}
**Total Tokens:** ${tokens.length}

> **Purpose:** Compare the "Initial AI Analysis" vs "Actual Market Performance" to identify logic gaps.

---

`;

    for (const t of tokens) {
        const entryMc = t.alertMc || 1;
        const athMc = t.athMc || entryMc;
        const mc30 = t.mc30m || 0;
        const mult = athMc / entryMc;
        const mult30High = (t.maxMc30m || 0) / entryMc;

        // Status Icon
        let icon = '⚪'; // Mid
        if (mult >= 2.0) icon = '🚀'; // Moon
        else if (mult >= 1.5) icon = '✅'; // Profit
        else if ((t.soldMc && t.soldMc < entryMc) || mc30 < entryMc) icon = '❌'; // Loss

        // Analysis Parsing
        let analysisText = "_No AI analysis stored_";
        let riskLevel = "N/A";
        let confidence = "N/A";

        if (t.storedAnalysis) {
            try {
                // Try parsing JSON if valid
                const json = JSON.parse(t.storedAnalysis);
                analysisText = json.explanation ? json.explanation.join('\n\n') : JSON.stringify(json, null, 2);
                riskLevel = json.riskLevel || "N/A";
                confidence = json.confidenceScore ? `${json.confidenceScore}/100` : "N/A";
            } catch (e) {
                // Raw text fallback
                analysisText = t.storedAnalysis;
            }
        }

        md += `## ${icon} ${t.symbol} ($${Math.floor(entryMc).toLocaleString()})
**Mint:** \`${t.mint}\`

<details>
<summary>📦 View Raw AI Input Data (JSON)</summary>

\`\`\`json
${t.rawSnapshot ? JSON.stringify(t.rawSnapshot, null, 2) : '"No Raw Data Stored"'}
\`\`\`
</details>

### 📊 Performance
*   **Multiplier (ATH):** **${mult.toFixed(2)}x**
*   **Current MC:** $${Math.floor(t.currentMc || 0).toLocaleString()} (${((t.currentMc || 0) / entryMc).toFixed(2)}x)
*   **30m High:** ${mult30High > 0 ? mult30High.toFixed(2) + 'x' : 'N/A'}
*   **Status:** ${t.status}
*   **Entry:** $${Math.floor(entryMc).toLocaleString()}
*   **ATH:** $${Math.floor(athMc).toLocaleString()} ${athMc === entryMc ? '(No pump)' : ''}

### 🧠 Original AI Insight
*   **AI Score:** **${t.lastScore || 'N/A'}/100**
*   **Risk Level:** ${riskLevel}
*   **Confidence:** ${confidence}

> ${analysisText.replace(/\n/g, '\n> ')}

---

`;
    }

    const outputPath = path.join(process.cwd(), 'AUTOPSY_FULL.md');
    fs.writeFileSync(outputPath, md);
    console.log(`Report generated at: ${outputPath}`);
    process.exit(0);
}

main().catch(console.error);
