# Birdeye Holder Integration Guide

Bu doküman, TrendBot projesinde Birdeye üzerinden holder verilerinin nasıl çekildiğini ve işlendiğini açıklar.

## 1. Kullanılan Metodoloji (Hybrid Strategy)
Bot, en güncel ve doğru holder verisini almak için iki aşamalı bir "Hybrid" yaklaşım kullanır:

### Strateji A: Birincil Dağılım (Primary Distribution)
En sağlıklı veriyi sağlayan ana yöntemdir.
- **Uç Nokta:** `https://public-api.birdeye.so/defi/token_holder_distribution`
- **Kritik Parametre:** `token_address` (DİKKAT: `address` değil, `token_address` kullanılmalıdır ⚠️)
- **Mantık:** Dönen listedeki ilk 10 elemanın `percent_of_supply` değerleri toplanır.

### Strateji B: Hibrit Yedekleme (Fallback)
Yeni çıkan tokenlarda Dağılım API'si (404) dönebildiği için devreye girer.
- **Uç Noktalar:** `/defi/v3/token/holder` + `/defi/token_overview`
- **Mantık:** 
  1. `v3/token/holder` listesinden ilk 10 holder'ın `amount` değerleri alınır.
  2. `token_overview` üzerinden toplam `supply` çekilir.
  3. Formül: `(İlk 10 Toplam Amount) / (Total Supply)`

## 2. Teknik Detaylar

### Config Ayarları (.env)
```env
BIRDEYE_API_KEY=e7724662fb4b49db991cffe5bbac36b3
```

### Log Senaryoları
Sistem her aşamada detaylı log üretir:
- `[Birdeye] Using Fallback Holder Logic for ...`: Birincil metodun 404 döndüğü durum.
- `[REJECT] SYMBOL -> Whale Risk (65%)`: Top 10 cüzdanın elindeki miktar %50'yi aştığında.
- `[REJECT] SYMBOL -> Bot Risk (12 Holders)`: Yatırımcı sayısı 50'den az olduğunda.

## 3. Test ve Debugging
Yeni bir tokenı manuel test etmek için PowerShell üzerinden şu komutu kullanabilirsiniz:

```powershell
npx ts-node scripts/test_birdeye_holders.ts
```

## 4. Fail-Safe Kuralları
- **Hata Yönetimi:** API'den cevap alınamazsa (429, 500 vb.), bot güvenlik için tokenı **REJECT** (Red) eder.
- **Rate Limit:** 429 hatası durumunda otomatik olarak bekleme (backoff) ve 2 kez tekrar deneme yapılır.
