# 🌐 TrendBot: End-to-End Workflow & Architecture

This document details the complete lifecycle of the **TrendBot** system, explaining how it finds, analyzes, executes, and monitors trading opportunities.

---

## 🏗️ Architecture Overview

The system is built on **Node.js / TypeScript** and uses a **PostgreSQL** database for persistence. It operates as a set of concurrent "Jobs" and "Services".

### Key Components:
1.  **Jobs:** Long-running processes (e.g., `TokenScanJob`, `PortfolioTrackerJob`).
2.  **Services:** Specialized helpers (e.g., `BirdeyeService`, `GeminiService` for AI).
3.  **Storage:** `PostgresStorage` managing the `token_performance` and `seen_tokens` tables.
4.  **Web:** `DashboardServer` (Express.js) rendering the UI.

---

## 🔄 The Pipeline: From Discovery to Autopsy

### 1️⃣ Phase 1: Discovery (Searching)
**Goal:** Identifying potential tokens before they moon.
*   **Source:** The bot queries **Birdeye** (`/defi/token_trending` or `/defi/v3/token/list`) or **DexScreener** APIs.
*   **Logic:** It looks for tokens with:
    *   High Momentum (Volume/Liquidity ratio).
    *   Freshness (Newer than X minutes, older than Y minutes to avoid instant rugs).
    *   Specific thresholds (e.g., `minLiquidity: $5k`, `minVolume: $10k`).
*   **File:** `jobs/TokenScanJob.ts` -> `services/BirdeyeService.ts`.

### 2️⃣ Phase 2: Filtering (The Gate)
**Goal:** Eliminating obvious garbage (scams, dead coins).
*   **Technical Filters:**
    *   **Liquidity Lock:** Checks if LP is burned/locked (via `RugCheck` or `Goplus` if enabled, currently heuristics).
    *   **Pattern Matching:** `Matcher.ts` checks for "hard rules" (e.g., blacklist words in name, suspicious developer supply).
    *   **Phase Detector:** `PhaseDetector.ts` ensures the token isn't already "dead" or in a severe downtrend.
*   **Outcome:** If a token passes, it moves to the **AI Queue**.

### 3️⃣ Phase 3: AI Analysis (The Brain) 🧠
**Goal:** Predicting success probability using LLMs.
*   **Input Data:** The system gathers a "Snapshot" including:
    *   Price, Market Cap (Entry & ATH), Liquidity.
    *   Social Signals (Twitter mentions via `AlphaSearchService`).
    *   Holders count, Volume.
*   **Processing:**
    *   `GeminiService` (or configured LLM) receives this JSON snapshot.
    *   **Prompt:** It asks the AI to act as a "Senior Crypto Analyst" and rate the token **0-100**.
    *   **Heuristics:** The AI looks for "Alpha" (influencer mentions), "Strength" (volume > liquidity), and "Narrative" (AI, meme, tech).
*   **Scoring:**
    *   **Score > 85:** 💎 **GEM** (High Conviction).
    *   **Score > 75:** 🟢 **GOOD** (potential).
    *   **Score < 50:** 🔴 **REJECT**.

### 4️⃣ Phase 4: Execution & Alerting
**Goal:** Logging the trade and notifying the user.
*   **Database:** A record is created in `token_performance` with `alert_timestamp`, `alert_mc` (Found MC), and `status='TRACKING'`.
*   **Telegram:** The bot sends a message to the channel with the metrics and the AI's verdict (`TelegramBot.ts`).
*   **Dashboard:** The token immediately appears on the Web Dashboard (`DashboardServer.ts`).

### 5️⃣ Phase 5: Lifecycle & Autopsy (Monitoring)
**Goal:** Tracking performance and generating reports.
*   **Live Tracking:** `PortfolioTrackerJob` runs every ~1-5 minutes to update `current_mc` and check if it hit ATH.
*   **The 30-Minute Rule:**
    *   The `AutopsyService` runs regularly.
    *   It specifically checks: "What was the price exactly 30 minutes after entry?" (`mc_30m`).
    *   It also scans: "What was the HIGHEST price during those first 30 minutes?" (`max_mc_30m`).
*   **Final Status:** A token is eventually marked as `MOONED` (if >2x), `RUGGED` (if <50%), or remains `TRACKING`.

---

## 📊 Reports & Analysis

The system produces detailed reports to help refine the strategy:

1.  **Dashboard:** Live view of all active and past trades.
2.  **AUTOPSY_FULL.md:** A generated file (by `scripts/generate_detailed_autopsy.ts`) that compares the **AI's Prediction** vs. **Reality**.
    *   It calculates ROI for different strategies (Split, Moonshot, Time-Limited).
    *   It reveals "Why" the AI took the trade (Raw JSON data + Explanation).

---

## 🛠️ Key Scripts

*   `npm run start`: Starts the main bot (Scanner + Dashboard).
*   `npx ts-node scripts/backfill_ath.ts`: Updates "True ATH" for historical accuracy.
*   `npx ts-node scripts/backfill_mc30m.ts`: Fetches historical 30m price points.
*   `npx ts-node scripts/generate_detailed_autopsy.ts`: Generates the comprehensive markdown report.

---
*Created automatically by TrendBot Agent*
