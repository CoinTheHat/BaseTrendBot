# 🤖 TrendBot & Scandex: Tam Sistem Analizi

Bu doküman, botun A'dan Z'ye nasıl çalıştığını, hangi teknolojileri kullandığını ve tokenları hangi aşamalardan geçirip elediğini detaylandırır.

---

## 🛠️ 1. Teknoloji Yığını (Tech Stack)

Sistem modern ve hızlı veri işleme üzerine kuruludur:
- **Ana Dil:** TypeScript / Node.js
- **Veri Kaynağı (Discovery):** DexScreener (Scraping & Internal API)
- **Tarayıcı Otomasyonu:** Playwright (Stealth Mode) - Cloudflare korumasını aşmak için.
- **Yapay Zeka (AI):** xAI (Grok-Beta) - Tweet analizi ve duygu ölçümü için.
- **Veritabanı:** PostgreSQL - Kalıcı veri saklama ve "Çoklu Trade" takibi için.
- **Arayüz:** Web Dashboard (EJS/Express) + Telegram Bot.

---

## ⚡ 2. Tarama ve Tespit Süreci (Workflow)

Bot, **30 saniyede bir** çalışan bir döngüye sahiptir. İşleyiş sırasıyla şöyledir:

### Adım 1: Keşif (Discovery)
- **Hedef:** DexScreener "Solana - Last 5 Mins - Trending" sayfası.
- **Yöntem:** Playwright tarayıcısı sayfayı açar, HTML'i tarar ve en yeni, trend olan yaklaşık 30-40 tokenı yakalar.

### Adım 2: Güvenlik Duvarı (The Firewall) 🛡️
Tokenlar analiz edilmeden önce "Çöp" veya "Tehlikeli" olanlar anında elenir. Kurallar kesindir:

1.  **Blacklist:** İsimde yasaklı kelimeler (pedo, nazi, vs.) varsa -> **RED.**
2.  **Likidite (Liquidity):**
    *   Likidite < $5,000 -> **RED** (İşlem yapılamaz).
    *   Likidite / MarketCap Oranı < %5 -> **RED** (Aşırı volatil/Manipülasyon).
    *   Likidite / MarketCap Oranı > %90 -> **RED** (Honeypot Riski).
3.  **Yaş Sınırı (Age):**
    *   20 dakikadan genç -> **RED** (Çok riskli).
    *   1 haftadan (168 saat) yaşlı -> **RED** (Bayat).
4.  **Güvenlik Kontrolleri (DexScreener API):**
    *   **Mint Authority:** Açık mı? -> **RED** (Dev yeni coin basabilir).
    *   **Freeze Authority:** Açık mı? -> **RED** (Cüzdan dondurulabilir).
    *   **Top 10 Holder:** Arzın %50'sinden fazlasına sahipse -> **RED** (Balina riski).
    *   **Liquidity Burned:** %80'den az ise -> **UYARI/CEZA.**

### Adım 3: Teknik Puanlama (Mechanical Score) 📊
Filtreleri geçen tokenlar, matematiksel verilere göre 0-100 arası bir taban puan alır:
- **Hacim:** 5dk hacmi > $10k ise puan artar.
- **Trend:** Fiyat hareketleri pozitifse puan artar.
- **Yaş Cezası:** Token eskidikçe puanı kırılır (-10 ile -30 puan arası).

### Adım 4: Yapay Zeka Denetçisi (AI Auditor & Vibe Check) 🧠
Teknik olarak geçen tokenlar, xAI'a gönderilir. AI, Twitter (X) üzerindeki son tweetleri okur ve bir "Ruthless Auditor" (Acımasız Denetçi) gibi davranır.

**Puanlama Mantığı (-100 ile +100):**

❌ **Ceza Puanları (Negatif Sinyaller):**
*   **-20 Puan:** "Alpha Group" davetleri veya Kopyala-Yapıştır bot yorumları.
*   **-15 Puan:** "Pump", "Raid", "Shill" gibi agresif kelimeler.
*   **-10 Puan:** "100x gem", "Moon mission", "LFG" gibi boş hype spamleri.
*   **-5 Puan:** Sadece emojiden oluşan kalitesiz hesaplar.

✅ **Ödül Puanları (Pozitif Sinyaller):**
*   **+30 Puan:** Teknoloji veya sanat hakkında özgün yorumlar.
*   **+25 Puan:** Orijinal Meme ve şakalar.
*   **+20 Puan:** Akıllı para (Smart Money) analizi yapanlar.
*   **+15 Puan:** Gerçek insan soruları ("Dev kim?", "Roadmap ne?").

AI Sonucu, genel skora eklenir. Eğer AI puanı **negatifse**, token büyük ihtimalle elenir.

### Adım 5: Nihai Karar ve Re-Alert 🚦
Teknik Puan + AI Puanı toplanır (= Combined Score).

1.  **YENİ GİRİŞ:** Toplam Puan **> 70** ise -> **SİNYAL GÖNDERİLİR.** 🚀
2.  **TEKRAR GİRİŞ (Re-Alert):**
    *   Eğer token daha önce paylaşılmışsa, bot veritabanına bakar.
    *   En az **2 saat** geçmiş olmalıdır.
    *   **VE** Puanı bu sefer **> 80** olmalıdır. (Vasat tokenlar ikinci kez paylaşılmaz).

---

## 💾 3. Veritabanı ve İzleme (Storage)

Onaylanan tokenlar PostgreSQL'e kaydedilir.
- **Çoklu Takip (Multi-Trade):** Aynı token farklı zamanlarda tekrar sinyal verirse (örn: düştü ve kalktı), sistemde **yeni bir satır** olarak açılır. Eskisi "SOLD" veya "RUGGED" olarak kalırken, yenisi "TRACKING" olarak canlı takip edilir.
- **Dashboard:** Web arayüzü, veritabanındaki bu "TRACKING" durumundaki tokenları canlı olarak listeler.

---

Özetle: Bot **çöpleri teknik filtrelerle**, **dolandırıcıları yapay zeka ile** eler ve sadece "Hikayesi olan, tekniği sağlam" tokenları önünüze getirir.
