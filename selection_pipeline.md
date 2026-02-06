# 🦅 Büyük Filtre: TrendBot Seçim Süreci

Bu belge, bir tokenin keşfedilmesinden alarma dönüşmesine kadar geçen yaşam döngüsünü detaylandırır.

## 1. Keşif (Geniş Ağ)
**Kaynak:** DexScreener (Scraping & API)
- **Filtreler:** Solana Ağı, Trend Olanlar, Yeni Çiftler.
- **Hacim:** Yüksek verimli tarama (Dakikada ~300 token).

## 2. Sert Kapılar (Mekanik Güvenlik Duvarı)
Hiçbir maliyetli API çağrısı yapılmadan önce, bot anında elemeler yapar:
1.  **Kara Liste Kontrolü:** İsimde yasaklı kelimeler (örn: "pedo", "nazi") var mı?
2.  **Likidite Kapısı:** En az **$5,000** olmalı.
3.  **Yaş Kapısı:** En az **20 Dakika** olmalı ("Altın Aralık").
4.  **Oran Kapısı:** Hacim/Likidite oranı sağlıklı olmalı (%5 - %90).

## 3. Risk Analizi (Derin Tarama)
Sert Kapıları geçen tokenlar derinlemesine incelenir:
1.  **Holder (Tutucu) Kontrolü (3 Katmanlı Yedekleme):**
    - **Katman 1:** Birdeye API (En Hızlısı).
    - **Katman 2:** Solana RPC (Güvenilirlik).
    - **Katman 3:** DexScreener Aktif Tüccarlar (Yedek).
    - **KURAL:** Kesinlikle **50'den fazla Holder** olmalı.
2.  **Balina Kontrolü:** İlk 10 cüzdan, arzın **%50'sinden azına** sahip olmalı.
3.  **RugCheck:** Temel yetki/mint analizi.

*Burada elenenler "Bot Riski" veya "Balina Riski" gibi nedenlerle reddedilir.*

## 4. Teknik Puanlama (Taban Puan)
Puanlar şunlara göre verilir:
- **Market Değeri (MC):** ($50k - $300k arası en tatlı nokta)
- **Momentum:** İşlem hızlanması.
- **Alım Baskısı:** Alım/Satım Oranı.
- **Likidite Kalitesi:** Kilitli likidite durumu.

**Sonuç:** Bir `Teknik Puan` (0-100 arası).

## 5. Sosyal Denetim (Acımasız AI) 🧠
Sadece yüksek Teknik Puana sahip tokenlar buraya gelebilir.
1.  **Veri Madenciliği:** Son **4 Saatte** atılan **100 Tweet** toplanır.
2.  **Analiz:** AI ("Denetçi"), bu 100 tweetin TAMAMINI okur.
3.  **Vibe Puanı (-100 ile +100):**
    - **Shill/Spam/Kopyala-Yapıştır:** Negatif Puan (Ceza Puanı). 🟥
    - **Organik/Teknoloji/Meme:** Pozitif Puan (Bonus). 🟩

## 6. Son Kapı 🚪
**Formül:** `Teknik Puan` + `Vibe Puanı` = `Birleşik Puan`

**KURAL:** `Birleşik Puan` **>= 70** olmalı.

- **< 70:** REDDEDİLDİ ("Zayıf Puan").
- **>= 70:** **SNIPE ALARMI!** 🔫

## ❓ Otopsi Raporu (Kayıtlar)
- **Başarılı Alarmlar:** Veritabanına (`seen_tokens`) tüm puan detaylarıyla kaydedilir.
- **Reddedilenler:**
  - **Loglanır:** Konsola ve dosyaya (`logs/app.log`) nedeni yazılır (örn: `[REJECT] $SCAM -> Copy-Paste Detected`).
  - **Hafıza:** Tekrar taranmasın diye kısa süreliğine (1-12 saat) RAM'de tutulur.
  - **Veritabanı:** ❌ Veritabanına **KAYDEDİLMEZ**. Çöp verilerle şişirmemek için reddedilenlerin geçmişini tutmuyoruz.
