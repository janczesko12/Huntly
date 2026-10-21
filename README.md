# Huntly — PWA

Huntly is a browser-based outdoor hide-and-seek game for Android and iPhone. It uses a single Progressive Web App (PWA); there is no native APK or Android Studio project.

## Features

- Animated mobile-first Huntly UI.
- Firebase Anonymous Authentication and Firestore-backed rooms.
- Create a room, share a join code, join the lobby, and restore the current player after refresh.
- Host/searcher and runner roles.
- Adjustable escape time, location-signal cadence and round duration.
- Leaflet map using OpenStreetMap tiles.
- Location required to create/join/resume a room; GPS updates every 10 seconds while the page is active and browser geolocation is available.
- Live Firestore listeners plus a periodic 10-second refresh.
- Temporary runner location reveals, countdown, 5 m capture with a 2-second hold, and a Firebase callable function that validates the catch before changing the runner into a seeker.
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
firebase deploy --only hosting,functions,firestore:rules
```

Live URL: https://huntly-game.web.app

To run a local Hosting preview:

```powershell
firebase emulators:start --only hosting
```

## Firebase setup

1. In Firebase Console, open **Authentication → Sign-in method** and enable **Anonymous**.
2. Create a Firestore database.
3. The repository's `firebase.rules` are linked through `firebase.json`. Deploy the Hosting app, callable Function, and Firestore rules together so the catch button does not call a missing backend and clients cannot edit player roles directly.

The browser Firebase configuration in `pwa/app.js` is client-side configuration, not a Service Account private key. The `captureRunner` Cloud Function runs in `europe-west1`; deploying Cloud Functions requires a Firebase project plan that supports Functions (typically the Blaze plan with billing enabled).

GPS accuracy and timestamps are validated by the server, but a browser cannot cryptographically prove that submitted coordinates come from a physical GPS sensor. Do not treat this as anti-cheat-grade location attestation.

### Important security notes

Firestore rules restrict room settings to the host and prevent clients from directly changing player roles. The capture action is checked by the `captureRunner` Cloud Function in a Firestore transaction.

**Location privacy limitation:** player GPS coordinates are still stored in player documents, which other authenticated members of that room can read. The map hides runner positions during hidden periods, but this is a UI rule, not confidential storage. Before a public launch with strangers, move location data to a separate collection with role-based read rules and migrate existing rooms.

Browser GPS data is client-supplied and can be spoofed by a modified client; accuracy and age checks help reject bad fixes but do not provide hardware-backed location attestation.

### Automated deploy

The GitHub Actions workflow runs JavaScript syntax checks and the capture validation tests on pushes to `main`. To enable its production deployment, add a repository Actions secret named `FIREBASE_SERVICE_ACCOUNT_HUNTLY_GAME` containing the JSON key for a service account authorized to deploy Firebase Hosting, Cloud Functions and Firestore rules. The workflow deliberately skips deployment when this secret is missing.

Deploying Cloud Functions also requires Firebase billing to be enabled (typically the Blaze plan).

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
