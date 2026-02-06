# 🧠 TrendBot V1: Full Selection Criteria (The "Brain")

This document details every single filter, rule, and score factor used by the bot to select a token.
**If a token is shared, it has passed ALL hurdles below.**

---

## phase 0: The Pool (Source)
**Source:** DexScreener "Trending M5" (Solana)
- **Filters:**
  - Chain: `Solana`
  - Address: Valid Mint (No `0x...` ETH addresses)
  - Rank: Top 100 Trending

---

## Phase 1: Hard Gates (The Firewall)
A token is **rejected immediately** if it fails any of these checks. No scoring happens.

| Check | Requirement | Reason |
| :--- | :--- | :--- |
| **🔎 Blacklist** | No banned words (e.g. `nazi`, `child`, `rape`) | Basic Trust / Safety |
| **💧 Liquidity** | **Min $5,000 USD** | Avoid un-tradable dust |
| **⚖️ Liq/MC Ratio** | **5% - 90%** | <5% = Slippage Hell, >90% = Honeypot Risk |
| **⏳ Age** | **10m - 7 Days** | Avoid instant rugs (<10m) and dead coins (>1w) |
| **🔒 RugCheck** | **API Status: "Safe"** | Checks contract authority, mintability, etc. |
| **👥 Holders** | **Min 50 Holders** (Strict) | Filters ghost tokens. Fallback: Active Buyers count. |
| **🐋 Whale Risk** | Top 10 Holders **< 50% Supply** | Prevents single-holder dumps |

---

## Phase 2: Technical Scoring (0-100 pts)
Points are awarded based on market metrics. **Minimum to pass Phase 2: 40 pts.**

### 1. Market Cap (The Zone)
- **Seed ($10k - $50k):** `+30 pts` (High Risk/Reward)
- **Golden ($50k - $250k):** `+50 pts` (🏆 Best Zone)
- **Runner (>$250k):** `+20 pts` (Need momentum to pass)
- **Micro (<$10k):** `0 pts` (REJECTED)

### 2. Momentum (Speed)
- **Hyper Active (>100 tx/5m):** `+15 pts`
- **Active (>40 tx/5m):** `+10 pts`
- **Dead (<10 tx/5m):** `-20 pts` (Penalty)

### 3. Buy Pressure
- **Strong (>60% Buys):** `+15 pts`
- **Weak (<40% Buys):** `-10 pts`

### 4. Freshness
- **Newborn (<10m):** `+10 pts`
- **Early (<30m):** `+5 pts`
- **Old (>4h):** `-10 pts` to `-30 pts` (Graduated Penalty)

### 5. Other
- **Meme Match:** `+5 pts` (If name matches trending keywords)
- **Dump:** `-20 pts` (if price dipped >20%)
- **Fake Pump:** **IMMEDIATE REJECT** (Price Up + Low Buy Count)

---

## Phase 3: Social Scoring (0-30 pts)
**Source:** Twitter Search (Last 50 Tweets) via `bird.fast`
AI analyzes activity for:
- **Red Flags:** Copy-paste spam, only 1 author, incoherent shilling.
- **Green Flags:** Diverse organic posts, meme quality, "Real Human" vibe.
- **Score:** Adds `0` to `30` points.

---

## 🏁 The Final Gate
**Formula:** `Technical Score` + `Social Score` = `Combined Score`

### 🛡️ PASS CONDITION: `Combined Score >= 70`
*(Example: Technical 50 + Social 20 = 70 -> ✅ PASS)*
*(Example: Technical 60 + Social 5 = 65 -> ❌ REJECT)*

---
**Summary:** The bot looks for **"Golden Zone" tokens ($50k-$250k MC)** that are **Active (>40 tx/5m)**, have **Safe Liquidity**, and a **Real Community** on Twitter.
