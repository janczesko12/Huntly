import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapture, distanceMeters, CAPTURE_HOLD_MS, CAPTURE_HOLD_TTL_MS } from './domain.js';

const NOW = 1_800_000_000_000;
const point = (lat, lng, overrides = {}) => ({ lat, lng, accuracy: 3, locationUpdatedAt: NOW, ...overrides });

test('accepts accurate fresh locations within 5 metres', () => {
  const result = validateCapture(point(52, 21), point(52, 21.00002), NOW);
  assert.equal(result.ok, true);
  assert.ok(result.distanceMeters <= 5);
});
test('rejects locations farther than 5 metres', () => {
  const result = validateCapture(point(52, 21), point(52, 21.0002), NOW);
  assert.equal(result.ok, false);
});
test('rejects stale or future location timestamps', () => {
  assert.equal(validateCapture(point(52, 21), point(52, 21.00001, { locationUpdatedAt: NOW - 15001 }), NOW).ok, false);
  assert.equal(validateCapture(point(52, 21), point(52, 21.00001, { locationUpdatedAt: NOW + 2001 }), NOW).ok, false);
});
test('rejects imprecise or invalid coordinates', () => {
  assert.equal(validateCapture(point(52, 21), point(52, 21.00001, { accuracy: 10.01 }), NOW).ok, false);
  assert.equal(validateCapture(point(52, 21), point(200, 21), NOW).ok, false);
});
test('server-side hold duration is two seconds and expires after a short window', () => {
  assert.equal(CAPTURE_HOLD_MS, 2000);
  assert.ok(CAPTURE_HOLD_TTL_MS >= CAPTURE_HOLD_MS);
});
test('distance helper rejects missing coordinates', () => {
  assert.equal(Number.isNaN(distanceMeters({}, { lat: 1, lng: 1 })), true);
});
