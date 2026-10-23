'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { validateCapture, shouldDeleteInactiveLobby } = require('./domain');

initializeApp();
const db = getFirestore();

exports.captureRunner = onCall({ region: 'europe-west1' }, async request => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Zaloguj się, aby łapać graczy.');
  }
  const seekerUid = request.auth.uid;
  const roomCode = String((request.data && request.data.roomCode) || '').trim();
  const runnerUid = String((request.data && request.data.runnerUid) || '').trim();

  if (!/^\d{6}$/.test(roomCode) || !runnerUid || runnerUid === seekerUid) {
    throw new HttpsError('invalid-argument', 'Nieprawidłowy pokój lub gracz.');
  }

  const roomRef = db.collection('rooms').doc(roomCode);
  const seekerRef = roomRef.collection('players').doc(seekerUid);
  const runnerRef = roomRef.collection('players').doc(runnerUid);

  try {
    return await db.runTransaction(async transaction => {
      const roomSnap = await transaction.get(roomRef);
      const seekerSnap = await transaction.get(seekerRef);
      const runnerSnap = await transaction.get(runnerRef);

      if (!roomSnap.exists || !seekerSnap.exists || !runnerSnap.exists) {
        throw new HttpsError('not-found', 'Pokój lub gracz już nie istnieje.');
      }
      const room = roomSnap.data();
      const seeker = seekerSnap.data();
      const runner = runnerSnap.data();

      if (room.status !== 'running') {
        throw new HttpsError('failed-precondition', 'Łapanie jest możliwe tylko podczas aktywnej rundy.');
      }
      if (seeker.role !== 'seeker' || seeker.alive === false) {
        throw new HttpsError('permission-denied', 'Tylko aktywny szukający może łapać.');
      }
      if (runner.role !== 'runner' || runner.alive === false) {
        throw new HttpsError('failed-precondition', 'Ten gracz nie jest już uciekającym.');
      }

      const validation = validateCapture(seeker, runner, Date.now());
      if (!validation.ok) {
        throw new HttpsError('failed-precondition', validation.message, {
          distanceMeters: Number.isFinite(validation.distanceMeters) ? validation.distanceMeters : null
        });
      }

      const caughtAt = FieldValue.serverTimestamp();
      transaction.update(runnerRef, {
        role: 'seeker',
        alive: true,
        caught: true,
        caughtBy: seekerUid,
        caughtAt,
        joinedSeekerTeamAt: FieldValue.serverTimestamp()
      });

      return {
        ok: true,
        distanceMeters: Math.round(validation.distanceMeters * 10) / 10,
        joinedTeam: 'seeker'
      };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('captureRunner failed', error);
    throw new HttpsError('internal', 'Nie udało się zweryfikować złapania. Spróbuj ponownie.');
  }
});


exports.cleanupInactiveLobbies = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Europe/Warsaw',
  region: 'europe-west1',
  timeoutSeconds: 300,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0
}, async () => {
  const snapshot = await db.collection('rooms')
    .where('status', 'in', ['lobby', 'expired'])
    .get();
  let deleted = 0;
  let failed = 0;

  for (const candidate of snapshot.docs) {
    let shouldDelete = false;
    try {
      await db.runTransaction(async transaction => {
        shouldDelete = false;
        const liveSnapshot = await transaction.get(candidate.ref);
        if (!liveSnapshot.exists) return;
        const room = liveSnapshot.data();

        // Retry recursive cleanup if an earlier scheduler run claimed the room
        // but did not finish deleting its subcollections.
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
      console.error('Lobby cleanup failed', candidate.id, error && error.message ? error.message : 'unknown');
    }
  }

  if (deleted || failed) {
    console.log('Inactive lobby cleanup:', JSON.stringify({ scanned: snapshot.size, deleted, failed }));
  }
});
