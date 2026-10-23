# Huntly — PWA

Huntly is a browser-based outdoor hide-and-seek game for Android and iPhone. It uses a single Progressive Web App (PWA); there is no native APK or Android Studio project.

## Features

- Animated mobile-first Huntly UI.
- Firebase Anonymous Authentication and Firestore-backed rooms.
- Create a room, share a join code, join the lobby, and restore the current player after refresh.
- Host/searcher and runner roles, with a shared full-screen 3–2–1 countdown and a role-specific reveal on every connected phone before the escape phase begins.
- Adjustable escape time, location-signal cadence and round duration.
- Leaflet map using OpenStreetMap tiles.
- Location required to create/join/resume a room; GPS updates every 10 seconds while the page is active and browser geolocation is available.
- Live Firestore listeners plus a periodic 10-second refresh.
- Temporary runner location reveals, countdown, 5 m capture with a 2-second hold, and a Cloudflare Worker backend that validates the catch before changing the runner into a seeker.
- Capture checks require both location updates to be no older than 15 seconds and GPS accuracy reported as 10 m or better.
- PWA manifest and service worker.

## Requirements

- Node.js (only required for Firebase CLI installation).
- Firebase project with Anonymous Authentication enabled and Firestore created.
- HTTPS origin for browser geolocation. Firebase Hosting provides HTTPS.

## Run locally / deploy

Install the Firebase CLI and authenticate:

```powershell
npm install -g firebase-tools
firebase login
```

This repository contains the browser-only PWA in `pwa/` and is configured to deploy to the existing Firebase project `huntly-game`:

```powershell
firebase deploy --only hosting,firestore:rules
```

Live URL: https://huntly-game.web.app

To run a local Hosting preview:

```powershell
firebase emulators:start --only hosting
```

## Firebase setup

1. In Firebase Console, open **Authentication → Sign-in method** and enable **Anonymous**.
2. Create a Firestore database.
3. The repository's `firebase.rules` are linked through `firebase.json`. Deploy Hosting and Firestore rules with Firebase; deploy the catch Worker separately to Cloudflare. The Worker verifies catches and updates the runner document in a Firestore transaction while client rules block direct role changes.

The browser Firebase configuration in `pwa/app.js` is client-side configuration, not a Service Account private key. The catch endpoint runs in Cloudflare Workers and uses the Firestore REST API with a service-account secret. This avoids deploying Cloud Functions and avoids upgrading Firebase to Blaze for this feature.

GPS accuracy and timestamps are validated by the server, but a browser cannot cryptographically prove that submitted coordinates come from a physical GPS sensor. Do not treat this as anti-cheat-grade location attestation.

### Important security notes

Firestore rules restrict room settings to the host and prevent clients from directly changing player roles. The capture action is checked by the Cloudflare Worker in a Firestore transaction. The server starts the hold timer and only permits the catch after at least two seconds, then checks both GPS samples again before changing the runner role.

**Location privacy limitation:** player GPS coordinates are still stored in player documents, which other authenticated members of that room can read. The map hides runner positions during hidden periods, but this is a UI rule, not confidential storage. Before a public launch with strangers, move location data to a separate collection with role-based read rules and migrate existing rooms.

Browser GPS data is client-supplied and can be spoofed by a modified client; accuracy and age checks help reject bad fixes but do not provide hardware-backed location attestation.

### Automated deploy

The GitHub Actions workflow runs JavaScript syntax checks and the capture validation tests on pushes to `main`. To enable production deployment, add the repository Actions secret `FIREBASE_SERVICE_ACCOUNT_HUNTLY_GAME` containing a JSON key for an account authorized to deploy Firebase Hosting and Firestore rules. The Cloudflare Worker has a separate setup described in `cloudflare/capture-worker/README.md`. The workflow deliberately skips deployment when this secret is missing.

Cloudflare Worker deployment is a separate step described in `cloudflare/capture-worker/README.md`; it does not deploy Cloud Functions.

## Browser and location limitations

- A website cannot turn on the phone's system Location Services switch or bypass user consent. It can request geolocation permission and block entry until it receives a position.
- Geolocation requires HTTPS, user permission, and device location services.
- Safari on iOS may suspend a PWA when it is backgrounded or the screen is locked; updates every 10 seconds cannot be guaranteed while the OS suspends the page.
- Location data is approximate. Play only in safe areas where outdoor games are allowed.

## Smoke-test checklist

Test with two separate devices:
- Create a room and join it with a code.
- Deny and grant GPS permissions.
- Refresh the page and verify the same room/player role is restored.
- Verify player positions and room state update.
- Test temporary location reveal, capture reporting, leaving a room and the end of the round.
- Check the browser developer console if Firebase reports an error.

## Automatic cleanup of idle lobbies

Lobby rooms are removed after 15 minutes without a meaningful lobby action. Creating or joining a room, returning to it, leaving it, copying the join code, or changing arena/host settings refreshes `lastActivityAt`. Background GPS updates and periodic refreshes do not count as user activity.

The `.github/workflows/cleanup-inactive-lobbies.yml` GitHub Actions workflow checks every 5 minutes and recursively deletes expired lobby documents plus their player/capture subcollections. It uses the existing repository secret `FIREBASE_SERVICE_ACCOUNT_HUNTLY_GAME`; no scheduled Firebase Function or Blaze upgrade is needed. Because the server-side sweep runs every 5 minutes, deletion occurs at the first sweep after the 15-minute inactivity threshold (normally within about 15–20 minutes). Only rooms still in the lobby state are deleted; rounds that have started or ended are preserved.
