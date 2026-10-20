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
- Temporary runner location reveals, countdown, capture reporting, leave-room flow and host handoff.
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
firebase deploy --only hosting
```

Live URL: https://huntly-game.web.app

To run a local Hosting preview:

```powershell
firebase emulators:start --only hosting
```

## Firebase setup

1. In Firebase Console, open **Authentication → Sign-in method** and enable **Anonymous**.
2. Create a Firestore database.
3. Review `firebase.rules` and publish the appropriate rules to Firestore.

The browser Firebase configuration in `pwa/app.js` is client-side configuration, not a Service Account private key.

### Important security warning

The included `firebase.rules` are intentionally marked as MVP/test rules. They allow any authenticated anonymous user to read/update rooms if they know the document ID. Do not use these rules for a public launch with strangers. Before public release, implement room membership checks, validation of allowed field/role changes, and preferably move sensitive game actions into trusted backend code.

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
