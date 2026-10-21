'use strict';

const CAPTURE_RADIUS_METERS = 5;
const CAPTURE_GPS_FRESH_MS = 15000;
const CAPTURE_MAX_ACCURACY_METERS = 10;

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + (Number(value.nanoseconds) || 0) / 1000000;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function distanceMeters(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lng)
    || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return NaN;
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const term = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(Math.max(0, 1 - term)));
}

function validateFreshPosition(player, label, now) {
  if (!player || !Number.isFinite(player.lat) || player.lat < -90 || player.lat > 90
    || !Number.isFinite(player.lng) || player.lng < -180 || player.lng > 180) {
    return { ok: false, message: label + ': brak prawidłowych współrzędnych GPS.' };
  }
  const accuracy = Number(player.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > CAPTURE_MAX_ACCURACY_METERS) {
    return { ok: false, message: label + ' musi mieć dokładność GPS do ' + CAPTURE_MAX_ACCURACY_METERS + ' m.' };
  }
  const updatedAt = timestampMillis(player.locationUpdatedAt);
  if (!updatedAt || now - updatedAt > CAPTURE_GPS_FRESH_MS || updatedAt - now > 2000) {
    return { ok: false, message: label + ' musi mieć GPS odświeżony w ciągu ostatnich 15 sekund.' };
  }
  return { ok: true };
}

function validateCapture(seeker, runner, now = Date.now()) {
  const seekerCheck = validateFreshPosition(seeker, 'Szukający', now);
  if (!seekerCheck.ok) return seekerCheck;
  const runnerCheck = validateFreshPosition(runner, 'Uciekający', now);
  if (!runnerCheck.ok) return runnerCheck;
  const distance = distanceMeters(seeker, runner);
  if (!Number.isFinite(distance) || distance > CAPTURE_RADIUS_METERS) {
    return {
      ok: false,
      message: 'Uciekający musi być w promieniu ' + CAPTURE_RADIUS_METERS + ' m.',
      distanceMeters: distance
    };
  }
  return { ok: true, distanceMeters: distance };
}

module.exports = {
  CAPTURE_RADIUS_METERS,
  CAPTURE_GPS_FRESH_MS,
  CAPTURE_MAX_ACCURACY_METERS,
  timestampMillis,
  distanceMeters,
  validateCapture
};
