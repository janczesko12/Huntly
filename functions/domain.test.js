'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCapture, distanceMeters } = require('./domain');

const NOW = 1_800_000_000_000;
function point(lat, lng, overrides = {}) {
  return {
    lat,
    lng,
    accuracy: 3,
    locationUpdatedAt: NOW,
    ...overrides
  };
}

test('accepts two fresh accurate positions within 5 meters', () => {
  const seeker = point(52, 21);
  const runner = point(52, 21.00002); // about 1.37 m at this latitude
  const result = validateCapture(seeker, runner, NOW);
  assert.equal(result.ok, true);
  assert.ok(result.distanceMeters <= 5);
});

test('rejects positions farther than 5 meters', () => {
  const result = validateCapture(point(52, 21), point(52, 21.0002), NOW);
  assert.equal(result.ok, false);
  assert.match(result.message, /promieniu 5 m/);
});

test('rejects a stale GPS fix', () => {
  const result = validateCapture(
    point(52, 21),
    point(52, 21.00001, { locationUpdatedAt: NOW - 15001 }),
    NOW
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /15 sekund/);
});

test('rejects a GPS timestamp too far in the future', () => {
  const result = validateCapture(
    point(52, 21),
    point(52, 21.00001, { locationUpdatedAt: NOW + 2001 }),
    NOW
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /15 sekund/);
});

test('rejects missing or low-quality accuracy', () => {
  const missing = validateCapture(point(52, 21), point(52, 21.00001, { accuracy: null }), NOW);
  const poor = validateCapture(point(52, 21), point(52, 21.00001, { accuracy: 10.01 }), NOW);
  assert.equal(missing.ok, false);
  assert.equal(poor.ok, false);
  assert.match(poor.message, /dokładność GPS/);
});

test('rejects malformed positions instead of treating them as zero distance', () => {
  const result = validateCapture(point(52, 21), point(200, 21), NOW);
  assert.equal(result.ok, false);
});

test('distance helper returns NaN for missing coordinates', () => {
  assert.equal(Number.isNaN(distanceMeters({}, { lat: 1, lng: 1 })), true);
});
