# 🛸 SCANDEX V1

**SCANDEX** is an automated Solana meme trend scanner with a "degen alien" persona. It watches for new tokens, filters them against a watchlist, and sends alerts to Telegram (and optionally Twitter).

* Last Updated: 2026-02-03 (Trigger v2)

## 🚀 Setup

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Configuration**
    *   Copy `.env.example` to `.env`.
    *   Fill in your API keys (Telegram is required).
    *   Adjust thresholds (Market Cap, Liquidity) as needed.

    ```bash
    cp .env.example .env
    # Edit .env and add:
    # TELEGRAM_BOT_TOKEN=...
    # TELEGRAM_CHAT_ID=...
    # TELEGRAM_ADMIN_ID=...
    ```

3.  **Build**
    ```bash
    npm run build 
    # OR directly run with ts-node
    ```

4.  **Run**
    ```bash
    npm start
    # OR dev mode
    npm run dev
    ```

## 📡 Features

*   **Multi-Source Scanning**: Fetches potential new tokens from Pump.fun and DexScreener.
*   **Meme Watchlist**: Manually manage phrases to watch for (e.g., "penguin", "dog", "pepe").
*   **Scoring Engine**: Evaluates tokens based on MC, Liquidity, Volume, and Watchlist match.
*   **Phase Detection**: Classifies tokens as `SPOTTED` 🛸, `TRACKING` 📡, `COOKING` 🔥, or `SERVED` 🍽.
*   **Narrative Alerts**: Sends unique, persona-driven stories to Telegram.

## 🛠 Admin Commands (Telegram)

*   `/status` - Check bot status and scan intervals.
*   `/watchlist` - View current tracked memes.
*   `/add <phrase> [tag1,tag2]` - Add a new meme to the watchlist.
    *   Example: `/add sad penguin penguin,depressed`

## 📂 Project Structure

*   `/services` - API Integrations (PumpFun, DexScreener, Birdeye)
*   `/core` - Business Logic (Matcher, Scoring, Phase)
*   `/narrative` - Alien Persona Text Generation
*   `/telegram` - Bot Interface
*   `/jobs` - Main Scanning Loop

## ⚠ Disclaimer

This bot is for entertainment and educational purposes only. **Not financial advice.**
