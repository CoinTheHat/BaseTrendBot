# 🛸 TRENDBOT V3 (Premium Sniper)

**TRENDBOT V3** is an institutional-grade, AI-powered Solana trend scanner and trading intelligence system. It combines high-frequency data analysis, a specific "Gap Filling" autopsy algorithm, and a Large Language Model (Grok) to identify high-potential "Gem" tokens while filtering out scams and noise.

*   **Current Version:** V3.1.0
*   **Last Updated:** 2026-02-04
*   **Core Engine:** Hybrid (Tech + AI)

## 📡 Key Features

### 1. 🔍 V3 Scanning Engine & Filters
The bot scans **DexScreener** for new pairs and applies a multi-layered filter:
*   **Floor Check:** Enforces dynamic Liquidity/MC ratio (20% for Low Cap, 4-10% for Mid/High Cap).
*   **Rug Check:** Rejects liquidity > 90% of MC (Suspicious).
*   **Momentum:** Requires `24hVol / Liq > 0.5x` to ensure activity.
*   **Ghost Protocol:** If no Twitter data is found, the token is penalized but sent to AI for a "Ghost Check".

### 2. 🧠 AI Gatekeeper (Scoring Engine)
A 7-layer scoring system (0-10 Points) evaluates every potential candidate:
*   **Technicals (6 Pts):** Market Cap, Liquidity, Volume, Momentum, Buy Pressure, Organic Price Action.
*   **AI Analysis (4 Pts + Bonus):** xAI (Grok) analyzes sentiment, narrative quality, and "Vibe".
    *   **Age Bonus:** <4h (+1), >24h (-2).
    *   **Narrative:** Detects genuine communities vs bot spam.
*   **Threshold:** Only tokens with **Score > 7** trigger an alert.

### 3. 💉 Autopsy & Gap Filling Algorithm (True ATH)
To utilize data for AI training ("Ground Truth"), the bot calculates the **True ATH** of every alerted token after 24 hours:
*   **Phase 1 (Precision):** Fetches **1-minute candles** from Entry -> Next 15m Boundary to capture immediate wicks.
*   **Phase 2 (Efficiency):** Fetches **15-minute candles** for the remaining 24 hours.
*   **Result:** A hyper-accurate "Max Multiplier" record used to grade the bot's own performance.

### 4. 📊 Dashboard & Portfolio Simulator
A web-based dashboard (via Railway) provides real-time PnL tracking:
*   **Live Trades:** Actionable table with Copy CA, Rug/Unrug buttons, and PnL calc.
*   **Autopsy Report:** Ranked list of the bot's past calls with True ATH multipliers.
*   **Simulator:** Calculates "What if I bet $100 on every alert?" (Investment vs Portfolio Value vs Net Profit).

## 🚀 Setup & Deployment

1.  **Environment**
    ```bash
    cp .env.example .env
    # Required: TELEGRAM_BOT_TOKEN, CHAT_ID, XAI_API_KEY, DATABASE_URL
    ```

2.  **Start System**
    ```bash
    npm install
    npm start
    ```

3.  **Dashboard**
    *   Accessible at `https://[railway-domain]`
    *   Auth: Admin / (See .env)

## 📂 Project Structure

*   `/jobs` - **TokenScanJob** (Scanner) & **PerformanceMonitorJob** (Autopsy/Tracking)
*   `/core` - **ScoringEngine** (The Brain), **PhaseDetector**
*   `/services` - **AutopsyService**, **LLMService** (Grok), **BirdeyeService**, **DexScreenerService**
*   `/storage` - **PostgresStorage** (Persistence)
*   `/web` - **DashboardServer** (Express UI)
*   `/narrative` - AI Personality Engine

## ⚔️ Disclaimer
This is an experimental trading tool. **Use at your own risk.** Crypto markets are highly volatile.
