# Huntly Capture Worker (bez Firebase Blaze)

Backend łapania dla PWA Huntly. Cloudflare Worker zastępuje callable Cloud Function, więc CI wdraża Firebase Hosting i Firestore rules bez Cloud Functions. Worker weryfikuje token Firebase, odczytuje pokój i pozycje w transakcji Firestore, zapisuje rozpoczęcie przytrzymania po stronie serwera, a po minimum 2 sekundach ponownie sprawdza GPS i atomowo zmienia rolę gracza.

## 1. Wymagania

- Konto Cloudflare z możliwością wdrażania Workers.
- Projekt Google Cloud/Firebase \`huntly-game\` z włączonym Anonymous Authentication oraz utworzoną bazą Firestore.
- Konto serwisowe Google dla projektu \`huntly-game\` z rolą IAM **Cloud Datastore User** (\`roles/datastore.user\`). Klucz JSON trzymaj wyłącznie jako sekret Cloudflare — nie zapisuj go w repozytorium ani w \`pwa/\`.
- Firebase Web API key z konfiguracji aplikacji.

## 2. Wdróż Worker

W PowerShell:

\`\`\`powershell
cd cloudflare/capture-worker
npm install
npx wrangler login
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
npx wrangler secret put FIREBASE_WEB_API_KEY
npm test
npm run check
npx wrangler deploy
\`\`\`

Przy obu poleceniach \`wrangler secret put\` wklej wartość, gdy terminal o to poprosi. Dla \`FIREBASE_SERVICE_ACCOUNT_JSON\` wklej cały JSON klucza konta serwisowego jako jeden tekst. Sekrety zapisują się w Cloudflare, nie w repozytorium.

Po wdrożeniu Cloudflare pokaże adres w rodzaju \`https://huntly-capture.TWOJ-SUBDOMAIN.workers.dev\`.

## 3. Podłącz PWA

Otwórz \`pwa/config.js\` i wstaw adres Worker jako \`captureApiUrl\`, bez końcowego ukośnika i bez ścieżki \`/capture\`:

\`\`\`js
window.HUNTLY_CONFIG = Object.freeze({
  captureApiUrl: 'https://huntly-capture.TWOJ-SUBDOMAIN.workers.dev'
});
\`\`\`

Zapisz zmianę, wypchnij ją na \`main\` i poczekaj na zielony workflow. GitHub Actions wdraża Firebase Hosting oraz reguły Firestore; Worker wdraża się osobno przez Wrangler.

## 4. Uprawnienia konta serwisowego

W Google Cloud Console dla projektu \`huntly-game\` przejdź do **IAM & Admin → IAM**, znajdź konto serwisowe i nadaj mu rolę **Cloud Datastore User**. Nie przyznawaj roli Owner. Worker korzysta z zakresu OAuth \`https://www.googleapis.com/auth/datastore\` i nie potrzebuje Cloud Functions, Cloud Build ani Artifact Registry.

## 5. Kontrola działania

- Otwórz \`https://huntly-game.web.app\` na dwóch telefonach.
- Utwórz pokój, dołącz drugim urządzeniem i rozpocznij rundę.
- Podejdź na mniej niż 5 m. Złapanie powinno zakończyć się dopiero po minimum 2 sekundach.
- Sprawdź, że łapanie zostanie odrzucone po oddaleniu się, utracie aktualnego GPS lub gdy gracz jest już złapany.

## Ograniczenia

Darmowy plan Cloudflare Workers ma limity żądań i zasobów; sprawdź aktualne limity na swoim koncie. Firestore i Authentication nadal podlegają limitom Firebase Spark. Weryfikacja serwerowa egzekwuje czas przytrzymania i blokuje bezpośrednią zmianę roli przez klienta, ale nie może dowieść, że urządzenie przekazuje prawdziwe fizyczne współrzędne GPS — zmodyfikowany klient nadal może próbować je fałszować.
