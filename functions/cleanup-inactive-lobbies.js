'use strict';

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { shouldDeleteInactiveLobby } = require('./domain');

const rawCredential = process.env.FIREBASE_SERVICE_ACCOUNT_HUNTLY_GAME;
if (!rawCredential) {
  throw new Error('Missing GitHub Actions secret FIREBASE_SERVICE_ACCOUNT_HUNTLY_GAME.');
}
const serviceAccount = JSON.parse(rawCredential);
initializeApp({
  credential: cert(serviceAccount),
  projectId: 'huntly-game'
});
const db = getFirestore();

async function main() {
  const snapshot = await db.collection('rooms')
    .where('status', 'in', ['lobby', 'expired'])
    .get();
  let deleted = 0;
  let failed = 0;

  for (const candidate of snapshot.docs) {
    let shouldDelete = false;
    try {
      await db.runTransaction(async transaction => {
        // A transaction can retry after a room activity update. Reset this
        // flag on every attempt so a fresh lobby is never deleted by mistake.
        shouldDelete = false;
        const live = await transaction.get(candidate.ref);
        if (!live.exists) return;
        const room = live.data();

        // Retry cleanup if a previous run marked the room expired but stopped
        // before removing its player and capture subcollections.
        if (room.status === 'expired') {
          shouldDelete = true;
          return;
        }
        if (!shouldDeleteInactiveLobby(room, Date.now())) return;

        transaction.update(candidate.ref, {
          status: 'expired',
          cleanupStartedAt: FieldValue.serverTimestamp()
        });
        shouldDelete = true;
      });

      if (shouldDelete) {
        await db.recursiveDelete(candidate.ref);
        deleted += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(
        'Failed to clean up lobby ' + candidate.id + ':',
        error && error.message ? error.message : 'unknown error'
      );
    }
  }

  console.log(JSON.stringify({
    scannedLobbies: snapshot.size,
    deletedLobbies: deleted,
    failedLobbies: failed,
    inactivityMinutes: 15
  }));

  await db.terminate();
  if (failed > 0) process.exitCode = 1;
}

main().catch(async error => {
  console.error('Inactive lobby cleanup failed:', error && error.message ? error.message : 'unknown error');
  try { await db.terminate(); } catch (_) {}
  process.exitCode = 1;
});
