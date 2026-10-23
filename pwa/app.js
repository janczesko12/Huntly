/* Huntly PWA — browser-only multiplayer MVP */
(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: 'AIzaSyDqVAfqehplpNagSln_s2SRBADRQ_eh2Bo',
    authDomain: 'huntly-game.firebaseapp.com',
    projectId: 'huntly-game',
    storageBucket: 'huntly-game.firebasestorage.app',
    messagingSenderId: '750741131486',
    appId: '1:750741131486:web:ad85ff6e8f94fa3533724f',
    measurementId: 'G-FS6054LH9R'
  };
  const SESSION_KEY = 'huntly.session.v1';
  const CAPTURE_API_URL = String((window.HUNTLY_CONFIG && window.HUNTLY_CONFIG.captureApiUrl) || '').trim();
  const GPS_INTERVAL_MS = 10000;
  const ROOM_REFRESH_MS = 10000;
  const $ = function (id) { return document.getElementById(id); };
  const state = {
    app: null, auth: null, db: null, uid: null, roomCode: null, room: null, me: null,
    players: [], roomUnsub: null, playersUnsub: null, map: null, markers: new Map(),
    gps: null, gpsWatch: null, gpsTimer: null, refreshTimer: null, gameTimer: null, areaCircle: null,
    roomBusy: false, locationReady: false, lastGpsAt: 0, lastRoomUpdate: 0, captureHolds: new Map(),
    countdownTransitionKey: null
  };

  function toast(title, message, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<strong></strong><span></span>';
    el.querySelector('strong').textContent = title;
    el.querySelector('span').textContent = message || '';
    $('toastRegion').appendChild(el);
    setTimeout(function () { el.classList.add('toast-out'); setTimeout(function () { el.remove(); }, 300); }, 4200);
  }
  function busy(on, message) {
    $('busy').classList.toggle('hidden', !on);
    if (message) $('busyText').textContent = message;
  }
  function friendlyError(error) {
    const code = error && error.code ? String(error.code) : '';
    if (code.indexOf('permission-denied') >= 0) return 'Firebase odmówił dostępu. Sprawdź reguły Firestore.';
    if (code.indexOf('unavailable') >= 0 || code.indexOf('network') >= 0) return 'Brak połączenia z serwerem. Sprawdź internet.';
    if (code.indexOf('auth/operation-not-allowed') >= 0) return 'W Firebase włącz Authentication → Anonymous.';
    if (code.indexOf('auth/network-request-failed') >= 0) return 'Nie udało się połączyć z Firebase Authentication.';
    if (code.indexOf('not-found') >= 0) return 'Nie znaleziono pokoju o tym kodzie.';
    if (error && error.message) return error.message;
    return 'Spróbuj ponownie za chwilę.';
  }
  function normalizeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 18) || 'Gracz';
  }
  function randomCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
  function sessionStore() {
    if (state.roomCode && state.me) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: state.roomCode, name: state.me.name }));
    }
  }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }
  function showWelcome() {
    $('welcome').classList.remove('hidden');
    $('game').classList.add('hidden');
    $('locationGate').classList.remove('location-ok');
  }
  function showGame() {
    $('welcome').classList.add('hidden');
    $('game').classList.remove('hidden');
  }
  function updateStartButton() {
    const hostCanStart = !!(state.room && state.room.hostUid === state.uid && state.room.status === 'lobby');
    const seekers = Math.max(1, Number($('seekerCount') && $('seekerCount').value) || 1);
    $('startBtn').disabled = !hostCanStart || state.players.length < seekers + 1;
  }
  function shufflePlayers(players) {
    const result = players.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const bytes = new Uint32Array(1);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
        const j = bytes[0] % (i + 1);
        const temp = result[i]; result[i] = result[j]; result[j] = temp;
      } else {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = result[i]; result[i] = result[j]; result[j] = temp;
      }
    }
    return result;
  }
  function setConnection(text, online) {
    $('connectionText').textContent = text;
    const dot = document.querySelector('.connection .pulse');
    if (dot) dot.classList.toggle('offline', !online);
  }

  async function initFirebase() {
    if (!window.firebase) throw new Error('Nie udało się załadować Firebase SDK.');
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    state.app = firebase.app();
    state.auth = firebase.auth();
    state.db = firebase.firestore();
    await state.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    if (!state.auth.currentUser) await state.auth.signInAnonymously();
    state.uid = state.auth.currentUser.uid;
    setConnection('FIREBASE ONLINE', true);
    return true;
  }

  function ensureLocation(options) {
    options = options || {};
    $('locationGate').classList.remove('location-ok');
    $('locationMessage').textContent = 'Sprawdzam dostęp do GPS…';
    if (!navigator.geolocation) {
      $('locationMessage').textContent = 'Ta przeglądarka nie obsługuje lokalizacji. Otwórz Huntly w aktualnej przeglądarce.';
      $('locationGate').classList.add('gate-error');
      return Promise.reject(new Error('Przeglądarka nie obsługuje GPS.'));
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      $('locationMessage').textContent = 'GPS wymaga bezpiecznego połączenia HTTPS.';
      $('locationGate').classList.add('gate-error');
      return Promise.reject(new Error('GPS wymaga HTTPS.'));
    }
    return new Promise(function (resolve, reject) {
      navigator.geolocation.getCurrentPosition(function (position) {
        state.gps = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          updatedAt: Date.now()
        };
        state.locationReady = true;
        state.lastGpsAt = Date.now();
        $('locationMessage').textContent = 'Lokalizacja działa. Dokładność około ' + Math.round(position.coords.accuracy || 0) + ' m.';
        $('locationGate').classList.add('location-ok');
        $('locationGate').classList.remove('gate-error');
        $('enableLocationBtn').textContent = 'GPS aktywny ✓';
        resolve(state.gps);
      }, function (error) {
        state.locationReady = false;
        let message = 'Nie udało się uzyskać pozycji. Włącz usługi lokalizacji i pozwól przeglądarce korzystać z GPS.';
        if (error.code === error.PERMISSION_DENIED) message = 'Brak zgody na lokalizację. Zezwól przeglądarce na dostęp do GPS w ustawieniach witryny.';
        if (error.code === error.POSITION_UNAVAILABLE) message = 'Telefon nie udostępnił pozycji. Włącz lokalizację systemową i spróbuj ponownie.';
        if (error.code === error.TIMEOUT) message = 'GPS nie odpowiedział na czas. Wyjdź na otwartą przestrzeń i spróbuj ponownie.';
        $('locationMessage').textContent = message;
        $('locationGate').classList.add('gate-error');
        $('enableLocationBtn').textContent = 'Spróbuj ponownie';
        reject(new Error(message));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: options.maximumAge || 0 });
    });
  }

  function updateMyPosition() {
    if (!state.roomCode || !state.db || !state.uid || !state.gps) return;
    const ref = state.db.collection('rooms').doc(state.roomCode).collection('players').doc(state.uid);
    const wasOutside = !!(state.me && state.me.outsideArea);
    const outsideArea = isOutsidePlayArea(state.gps, state.room);
    ref.update({
      lat: state.gps.lat,
      lng: state.gps.lng,
      accuracy: state.gps.accuracy,
      outsideArea: outsideArea,
      locationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      onlineAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function (error) {
      if (error.code !== 'not-found') console.warn('GPS sync:', error);
    });
    if (state.me) state.me.outsideArea = outsideArea;
    if (outsideArea && !wasOutside && state.room && state.room.status === 'running') {
      toast('Poza obszarem gry', 'Szukający będzie widział Twoją lokalizację na bieżąco.', 'error');
    } else if (!outsideArea && wasOutside) {
      toast('Wrócono do obszaru', 'Lokalizacja wraca do zwykłych zasad ujawniania.', 'success');
    }
  }

  function distanceMeters(a, b) {
    if (!a || !b || typeof a.lat !== 'number' || typeof a.lng !== 'number' || typeof b.lat !== 'number' || typeof b.lng !== 'number') return 0;
    const rad = function (value) { return value * Math.PI / 180; };
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  const CAPTURE_RADIUS_METERS = 5;
  const CAPTURE_HOLD_MS = 2000;
  const CAPTURE_GPS_FRESH_MS = 15000;
  const CAPTURE_MAX_ACCURACY_METERS = 10;

  function timestampMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value.seconds === 'number') return value.seconds * 1000 + (Number(value.nanoseconds) || 0) / 1000000;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function captureReadiness(seeker, runner, now) {
    now = typeof now === 'number' ? now : Date.now();
    const players = [{ data: seeker, label: 'Twój GPS' }, { data: runner, label: 'GPS uciekającego' }];
    for (let i = 0; i < players.length; i++) {
      const item = players[i];
      const p = item.data || {};
      if (typeof p.lat !== 'number' || !Number.isFinite(p.lat) || typeof p.lng !== 'number' || !Number.isFinite(p.lng)) {
        return { ok: false, label: 'Brak GPS', message: item.label + ': brak współrzędnych.' };
      }
      const accuracy = p.accuracy;
      if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > CAPTURE_MAX_ACCURACY_METERS) {
        return { ok: false, label: 'GPS niedokładny', message: item.label + ' musi mieć dokładność do ' + CAPTURE_MAX_ACCURACY_METERS + ' m.' };
      }
      const updatedAt = timestampMillis(p.locationUpdatedAt);
      if (!updatedAt || now - updatedAt > CAPTURE_GPS_FRESH_MS || updatedAt - now > 2000) {
        return { ok: false, label: 'GPS nieaktualny', message: item.label + ' musi być odświeżony w ciągu ostatnich 15 sekund.' };
      }
    }
    const distance = distanceMeters(seeker, runner);
    if (!Number.isFinite(distance) || distance > CAPTURE_RADIUS_METERS) {
      return { ok: false, label: 'Podejdź bliżej', message: 'Podejdź do uciekającego na maksymalnie 5 metrów. Teraz: ' + (Number.isFinite(distance) ? distance.toFixed(1) : '—') + ' m.', distance: distance };
    }
    return { ok: true, label: 'Przytrzymaj 2 s', message: 'Gracz jest w zasięgu.', distance: distance };
  }

  function makeCaptureNonce() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (!window.crypto || !window.crypto.getRandomValues) throw new Error('Ta przeglądarka nie obsługuje bezpiecznego identyfikatora łapania.');
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }

  async function nativeCaptureApi(action, payload) {
    const currentUser = state.auth && state.auth.currentUser;
    if (!state.db || !state.uid || !currentUser) throw new Error('Sesja Firebase wygasła. Odśwież stronę i spróbuj ponownie.');

    const roomCode = String(payload.roomCode || '').trim();
    const runnerUid = String(payload.runnerUid || '').trim();
    const nonce = String(payload.nonce || '').trim();
    if (!/^\d{6}$/.test(roomCode) || !/^[A-Za-z0-9_-]{1,128}$/.test(runnerUid) ||
        runnerUid === state.uid || !/^[0-9a-f-]{32,36}$/i.test(nonce)) {
      throw new Error('Nieprawidłowy pokój, gracz lub identyfikator łapania.');
    }

    const roomRef = state.db.collection('rooms').doc(roomCode);
    const seekerRef = roomRef.collection('players').doc(state.uid);
    const runnerRef = roomRef.collection('players').doc(runnerUid);
    const holdRef = roomRef.collection('captureHolds').doc(state.uid + '_' + runnerUid);

    if (action === 'cancel') {
      const holdSnap = await holdRef.get();
      if (holdSnap.exists) {
        const hold = holdSnap.data();
        if (hold.seekerUid === state.uid && hold.runnerUid === runnerUid && hold.nonce === nonce) {
          await holdRef.delete();
        }
      }
      return { ok: true, cancelled: true };
    }

    if (action === 'start') {
      // Clean up an abandoned hold after its server-enforced expiry.
      const existingSnap = await holdRef.get();
      if (existingSnap.exists) {
        const existing = existingSnap.data();
        const age = Date.now() - timestampMillis(existing.startedAt);
        if (existing.seekerUid === state.uid && existing.runnerUid === runnerUid &&
            existing.nonce === nonce && age >= 0 && age <= CAPTURE_HOLD_TTL_MS) {
          return {
            ok: true,
            startedAt: timestampMillis(existing.startedAt),
            distanceMeters: distanceMeters(state.me, state.players.find(function (p) { return p.uid === runnerUid; }))
          };
        }
        if (age >= 0 && age <= CAPTURE_HOLD_TTL_MS) {
          throw new Error('Masz już aktywną próbę łapania tego gracza. Puść przycisk i spróbuj ponownie.');
        }
        if (existing.seekerUid === state.uid) await holdRef.delete();
        else throw new Error('Ten gracz ma już aktywną próbę łapania. Spróbuj za chwilę.');
      }

      let checkedDistance = null;
      await state.db.runTransaction(async function (transaction) {
        const roomSnap = await transaction.get(roomRef);
        const seekerSnap = await transaction.get(seekerRef);
        const runnerSnap = await transaction.get(runnerRef);
        if (!roomSnap.exists || !seekerSnap.exists || !runnerSnap.exists) {
          throw new Error('Pokój lub gracz już nie istnieje.');
        }
        const room = roomSnap.data();
        const seeker = Object.assign({ uid: state.uid }, seekerSnap.data());
        const runner = Object.assign({ uid: runnerUid }, runnerSnap.data());
        if (room.status !== 'running') throw new Error('Łapanie jest możliwe tylko podczas aktywnej rundy.');
        if (seeker.role !== 'seeker' || seeker.alive === false) throw new Error('Tylko aktywny szukający może łapać.');
        if (runner.role !== 'runner' || runner.alive === false) throw new Error('Ten gracz nie jest już uciekającym.');
        const readiness = captureReadiness(seeker, runner, Date.now());
        if (!readiness.ok) throw new Error(readiness.message);
        checkedDistance = readiness.distance;
        transaction.set(holdRef, {
          seekerUid: state.uid,
          runnerUid: runnerUid,
          nonce: nonce,
          startedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });

      const holdSnap = await holdRef.get();
      if (!holdSnap.exists) throw new Error('Nie udało się zapisać próby łapania. Spróbuj ponownie.');
      const savedHold = holdSnap.data();
      if (savedHold.seekerUid !== state.uid || savedHold.runnerUid !== runnerUid || savedHold.nonce !== nonce) {
        throw new Error('Próba łapania została zastąpiona. Spróbuj ponownie.');
      }
      return { ok: true, startedAt: timestampMillis(savedHold.startedAt), distanceMeters: checkedDistance };
    }

    if (action === 'finish') {
      let capturedDistance = null;
      await state.db.runTransaction(async function (transaction) {
        const roomSnap = await transaction.get(roomRef);
        const seekerSnap = await transaction.get(seekerRef);
        const runnerSnap = await transaction.get(runnerRef);
        const holdSnap = await transaction.get(holdRef);
        if (!roomSnap.exists || !seekerSnap.exists || !runnerSnap.exists || !holdSnap.exists) {
          throw new Error('Próba łapania wygasła. Spróbuj ponownie.');
        }
        const room = roomSnap.data();
        const seeker = Object.assign({ uid: state.uid }, seekerSnap.data());
        const runner = Object.assign({ uid: runnerUid }, runnerSnap.data());
        const hold = holdSnap.data();
        if (room.status !== 'running') throw new Error('Runda nie jest już aktywna.');
        if (seeker.role !== 'seeker' || seeker.alive === false) throw new Error('Tylko aktywny szukający może łapać.');
        if (runner.role !== 'runner' || runner.alive === false) throw new Error('Ten gracz nie jest już uciekającym.');
        if (hold.seekerUid !== state.uid || hold.runnerUid !== runnerUid || hold.nonce !== nonce) {
          throw new Error('Przytrzymanie zostało przerwane. Spróbuj ponownie.');
        }
        const startedAt = timestampMillis(hold.startedAt);
        const elapsed = Date.now() - startedAt;
        if (!startedAt || elapsed < CAPTURE_HOLD_MS) throw new Error('Przytrzymaj jeszcze chwilę.');
        if (elapsed > CAPTURE_HOLD_TTL_MS) throw new Error('Próba łapania wygasła. Przytrzymaj przycisk ponownie.');
        const readiness = captureReadiness(seeker, runner, Date.now());
        if (!readiness.ok) throw new Error(readiness.message);
        capturedDistance = readiness.distance;
        transaction.update(runnerRef, {
          role: 'seeker',
          alive: true,
          caught: true,
          caughtBy: state.uid,
          caughtAt: firebase.firestore.FieldValue.serverTimestamp(),
          joinedSeekerTeamAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        transaction.delete(holdRef);
      });
      return { ok: true, distanceMeters: capturedDistance, joinedTeam: 'seeker' };
    }

    throw new Error('Nieznana operacja łapania.');
  }

  async function captureApi(action, payload) {
    // The native Firestore path keeps catching functional on Firebase Spark.
    // A separately deployed Cloudflare Worker remains supported when configured.
    if (!CAPTURE_API_URL || CAPTURE_API_URL.indexOf('workers.dev') < 0) {
      return nativeCaptureApi(action, payload);
    }
    const currentUser = state.auth && state.auth.currentUser;
    if (!currentUser) throw new Error('Sesja Firebase wygasła. Odśwież stronę i spróbuj ponownie.');
    const token = await currentUser.getIdToken();
    const response = await fetch(CAPTURE_API_URL.replace(/\/$/, '') + '/capture/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(payload)
    });
    let result = {};
    try { result = await response.json(); } catch (e) {}
    if (!response.ok || result.ok === false) throw new Error(result.error || 'Backend łapania zwrócił błąd (' + response.status + ').');
    return result;
  }

  function isOutsidePlayArea(position, room) {
    if (!room || typeof room.areaCenterLat !== 'number' || typeof room.areaCenterLng !== 'number') return false;
    const radius = currentZoneRadius(room, Date.now());
    return distanceMeters(position, { lat: room.areaCenterLat, lng: room.areaCenterLng }) > radius;
  }

  function beginGps() {
    stopGps();
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(onGpsSuccess, onGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    state.gpsWatch = navigator.geolocation.watchPosition(onGpsSuccess, onGpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    state.gpsTimer = setInterval(function () {
      navigator.geolocation.getCurrentPosition(onGpsSuccess, onGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }, GPS_INTERVAL_MS);
  }
  function onGpsSuccess(position) {
    state.gps = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null, updatedAt: Date.now() };
    state.locationReady = true;
    state.lastGpsAt = Date.now();
    $('mapUpdated').textContent = 'GPS ' + new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('lastUpdate').textContent = '• ' + new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    updateMyPosition();
    renderMap();
  }
  function onGpsError(error) {
    state.locationReady = false;
    if (error && error.code === error.PERMISSION_DENIED) {
      $('locationMessage').textContent = 'Dostęp do lokalizacji został zablokowany. Odblokuj GPS w ustawieniach przeglądarki.';
      $('locationGate').classList.add('gate-error');
    }
    $('mapUpdated').textContent = 'Oczekiwanie na GPS';
  }
  function stopGps() {
    if (state.gpsWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.gpsWatch);
    if (state.gpsTimer) clearInterval(state.gpsTimer);
    state.gpsWatch = null;
    state.gpsTimer = null;
  }

  async function createRoom() {
    if (state.roomBusy) return;
    state.roomBusy = true;
    busy(true, 'Sprawdzam lokalizację…');
    try {
      await ensureLocation();
      await state.authReady;
      const name = normalizeName($('createName').value);
      busy(true, 'Tworzę pokój…');
      let code = randomCode();
      let ref = state.db.collection('rooms').doc(code);
      for (let attempt = 0; attempt < 8; attempt++) {
        const snap = await ref.get();
        if (!snap.exists) break;
        code = randomCode();
        ref = state.db.collection('rooms').doc(code);
      }
      const now = firebase.firestore.FieldValue.serverTimestamp();
      await ref.set({
        code: code,
        hostUid: state.uid,
        status: 'lobby',
        createdAt: now,
        updatedAt: now,
        escapeSeconds: 30,
        roundMinutes: 20,
        areaCenterLat: state.gps.lat,
        areaCenterLng: state.gps.lng,
        areaRadiusMeters: 500,
        seekerCount: 1,
        zoneShrinkEnabled: false,
        zoneFinalRadiusMeters: 100,
        startedAt: null,
        escapeEndsAt: null,
        endedAt: null
      });
      const me = { uid: state.uid, name: name, role: 'seeker', alive: true, lat: state.gps.lat, lng: state.gps.lng, accuracy: state.gps.accuracy, joinedAt: now, locationUpdatedAt: now, onlineAt: now };
      await ref.collection('players').doc(state.uid).set(me);
      state.roomCode = code;
      state.me = { uid: state.uid, name: name, role: 'seeker', alive: true };
      sessionStore();
      openRoom(code);
      toast('Pokój utworzony', 'Twój kod to ' + code + '. Wyślij go znajomym.', 'success');
    } catch (error) {
      toast('Nie udało się utworzyć pokoju', friendlyError(error), 'error');
    } finally {
      busy(false);
      state.roomBusy = false;
    }
  }

  async function joinRoom() {
    if (state.roomBusy) return;
    state.roomBusy = true;
    busy(true, 'Sprawdzam lokalizację…');
    try {
      await ensureLocation();
      await state.authReady;
      const code = String($('roomCode').value || '').replace(/\D/g, '').slice(0, 6);
      if (code.length !== 6) throw new Error('Wpisz sześciocyfrowy kod pokoju.');
      const ref = state.db.collection('rooms').doc(code);
      const roomSnap = await ref.get();
      if (!roomSnap.exists) throw new Error('Nie znaleziono pokoju o kodzie ' + code + '.');
      const room = roomSnap.data();
      if (room.status !== 'lobby') throw new Error('Do pokoju można dołączyć tylko przed startem gry. Poproś hosta o nowy kod, jeśli runda już trwa.');
      const name = normalizeName($('joinName').value);
      busy(true, 'Dołączam do pokoju…');
      const playerRef = ref.collection('players').doc(state.uid);
      const previous = await playerRef.get();
      const old = previous.exists ? previous.data() : null;
      const me = {
        uid: state.uid, name: name, role: old ? old.role : (room.hostUid === state.uid ? 'seeker' : 'runner'),
        alive: old ? old.alive !== false : true,
        lat: state.gps.lat, lng: state.gps.lng, accuracy: state.gps.accuracy,
        joinedAt: old && old.joinedAt ? old.joinedAt : firebase.firestore.FieldValue.serverTimestamp(),
        locationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        onlineAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await playerRef.set(me, { merge: true });
      state.roomCode = code;
      state.me = { uid: state.uid, name: name, role: me.role, alive: me.alive };
      sessionStore();
      openRoom(code);
      toast('Dołączono do pokoju', 'Powodzenia w grze!', 'success');
    } catch (error) {
      toast('Nie udało się dołączyć', friendlyError(error), 'error');
    } finally {
      busy(false);
      state.roomBusy = false;
    }
  }

  async function restoreSession() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.roomCode) return;
    $('locationMessage').textContent = 'Odnawiam sesję. Sprawdzam GPS…';
    try {
      await ensureLocation();
      await state.authReady;
      const roomRef = state.db.collection('rooms').doc(String(saved.roomCode));
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) { clearSession(); return; }
      const playerRef = roomRef.collection('players').doc(state.uid);
      const playerSnap = await playerRef.get();
      if (!playerSnap.exists) { clearSession(); return; }
      const d = playerSnap.data();
      await playerRef.update({ lat: state.gps.lat, lng: state.gps.lng, accuracy: state.gps.accuracy, onlineAt: firebase.firestore.FieldValue.serverTimestamp(), locationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      state.roomCode = String(saved.roomCode);
      state.me = { uid: state.uid, name: d.name || saved.name || 'Gracz', role: d.role || 'runner', alive: d.alive !== false };
      sessionStore();
      openRoom(state.roomCode);
      toast('Witaj ponownie', 'Przywrócono Twoją sesję gry.', 'success');
    } catch (error) {
      $('locationMessage').textContent = 'Aby wrócić do zapisanej gry, włącz GPS i zezwól na lokalizację.';
      $('enableLocationBtn').textContent = 'Włącz GPS, aby wrócić';
      if (error.message && error.message.indexOf('GPS') < 0 && error.message.indexOf('lokaliz') < 0) {
        toast('Nie udało się przywrócić gry', friendlyError(error), 'error');
      }
    }
  }

  function syncPlayerCounts() {
    const count = Array.isArray(state.players) ? state.players.length : 0;
    const playerCount = $('playerCount');
    const rosterCount = $('rosterCount');
    if (playerCount) playerCount.textContent = count + (count === 1 ? ' gracz' : ' graczy');
    if (rosterCount) rosterCount.textContent = String(count);
  }

  function updateRoleBadge() {
    const badge = $('roleBadge');
    if (!badge) return;
    if (!state.room || state.room.status === 'lobby') badge.textContent = 'ROLA LOSOWANA';
    else if (state.room.status === 'countdown') badge.textContent = 'LOSOWANIE RÓL';
    else {
      const me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
      badge.textContent = me && me.role === 'seeker' ? 'SZUKAJĄCY' : 'UCIEKAJĄCY';
    }
  }

  function canEditArena() {
    return !!(state.room && state.room.status === 'lobby' && state.room.hostUid === state.uid && state.roomCode);
  }

  function updateArenaControls() {
    const controls = $('arenaControls');
    const notice = $('arenaReadOnly');
    const noticeText = $('arenaReadOnlyText');
    const canEdit = canEditArena();
    if (controls) controls.classList.toggle('hidden', !canEdit);
    if (notice) notice.classList.toggle('hidden', !(state.room && state.room.status === 'lobby' && !canEdit));
    if (noticeText && state.room) {
      noticeText.textContent = state.room.status === 'lobby'
        ? 'Tylko host może ustawić arenę. Poproś go, aby dotknął mapy na swoim telefonie.'
        : 'Arenę można zmienić tylko w poczekalni.';
    }
    const center = $('arenaCenterLabel');
    if (center) {
      center.textContent = state.room && typeof state.room.areaCenterLat === 'number' && typeof state.room.areaCenterLng === 'number'
        ? 'Środek areny zapisany • promień ' + Math.round(Number(state.room.areaRadiusMeters) || 500) + ' m'
        : 'Środek areny nie został ustawiony';
    }
  }

  async function saveArenaCenter(lat, lng) {
    if (!canEditArena()) {
      toast('Arenę ustawia host', 'Środek areny można zmienić wyłącznie w poczekalni hosta.', 'error');
      return false;
    }
    lat = Number(lat);
    lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast('Nieprawidłowa lokalizacja', 'Wybierz punkt na mapie albo spróbuj ponownie odczytać GPS.', 'error');
      return false;
    }
    try {
      const centerLat = Number(lat.toFixed(6));
      const centerLng = Number(lng.toFixed(6));
      await state.db.collection('rooms').doc(state.roomCode).update({
        areaCenterLat: centerLat,
        areaCenterLng: centerLng,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      state.room.areaCenterLat = centerLat;
      state.room.areaCenterLng = centerLng;
      updateArenaControls();
      if (state.map) state.map.setView([centerLat, centerLng], Math.max(15, state.map.getZoom()), { animate: true });
      renderMap();
      toast('Arena ustawiona', 'Środek areny został zapisany dla wszystkich graczy.', 'success');
      return true;
    } catch (error) {
      toast('Nie udało się zapisać areny', friendlyError(error), 'error');
      return false;
    }
  }

  function openRoom(code) {
    closeRoomListeners();
    state.roomCode = code;
    const ref = state.db.collection('rooms').doc(code);
    showGame();
    $('roomCodeDisplay').textContent = code;
    $('roomTitle').innerHTML = 'Pokój <em>' + code + '</em>';
    $('roleBadge').textContent = 'ROLA LOSOWANA';
    $('hostControls').classList.toggle('hidden', !(state.me && state.me.uid === state.uid && state.me.role === 'seeker'));
    $('gameActions').classList.remove('hidden');
    initMap();
    state.roomUnsub = ref.onSnapshot(function (snap) {
      if (!snap.exists) {
        toast('Pokój już nie istnieje', 'Wrócono do ekranu głównego.', 'error');
        exitRoom(false);
        return;
      }
      state.room = snap.data();
      state.lastRoomUpdate = Date.now();
      updateRoleBadge();
      updateArenaControls();
      renderPlayers();
      syncPlayerCounts();
      $('roomSubtitle').textContent = state.room.status === 'lobby' ? 'Poczekalnia • zaproś znajomych' : state.room.status === 'countdown' ? 'Role wylosowane • przygotuj się' : state.room.status === 'escape' ? 'Uciekający mają czas na ukrycie się' : state.room.status === 'running' ? 'Runda trwa — powodzenia!' : 'Rozgrywka zakończona';
      $('gameStatus').textContent = ({ lobby: 'Poczekalnia', countdown: 'Odliczanie', escape: 'Czas ucieczki', running: 'W trakcie gry', ended: 'Koniec rundy' })[state.room.status] || state.room.status;
      const isHost = state.room.hostUid === state.uid;
      $('hostControls').classList.toggle('hidden', !isHost || state.room.status !== 'lobby');
      updateStartButton();
      $('gameActions').classList.toggle('hidden', state.room.status === 'lobby' || state.room.status === 'ended');
      $('escapeSeconds').value = String(state.room.escapeSeconds || 30);
      $('roundMinutes').value = String(state.room.roundMinutes || 20);
      $('areaRadiusMeters').value = String(state.room.areaRadiusMeters || 500);
      $('seekerCount').value = String(state.room.seekerCount || $('seekerCount').value || 1);
      $('zoneShrinkEnabled').value = state.room.zoneShrinkEnabled ? 'on' : 'off';
      $('zoneFinalRadiusMeters').value = String(state.room.zoneFinalRadiusMeters || 100);
      updateStartButton();
      tickTimer();
    }, function (error) { toast('Błąd synchronizacji pokoju', friendlyError(error), 'error'); });
    state.playersUnsub = ref.collection('players').onSnapshot(function (snap) {
      state.players = snap.docs.map(function (doc) { const d = doc.data(); d.uid = doc.id; return d; });
      state.me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
      if (state.me) sessionStore();
      updateRoleBadge();
      updateArenaControls();
      state.captureHolds.forEach(function (_, uid) {
        const target = state.players.find(function (p) { return p.uid === uid; });
        if (!target || target.role !== 'runner' || target.alive === false || !state.me || state.me.role !== 'seeker') cancelCaptureHold(uid);
      });
      if (state.captureHolds.size === 0) renderPlayers();
      renderMap();
      syncPlayerCounts();
      updateStartButton();
      const runners = state.players.filter(function (p) { return p.role === 'runner' && p.alive !== false; }).length;
      if (state.room && state.room.status === 'running' && runners === 0) finishRoom('Szukający wygrywa — wszyscy uciekający zostali złapani.');
    }, function (error) { toast('Nie udało się pobrać graczy', friendlyError(error), 'error'); });
    beginGps();
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(function () {
      ref.get().then(function (snap) {
        if (snap.exists) state.room = snap.data();
        updateRoleBadge();
        updateArenaControls();
        return ref.collection('players').get();
      }).then(function (snap) {
        state.players = snap.docs.map(function (doc) { const d = doc.data(); d.uid = doc.id; return d; });
        state.me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
        syncPlayerCounts();
        updateStartButton();
        renderPlayers(); renderMap(); tickTimer();
      }).catch(function (error) { console.warn('Room refresh:', error); });
    }, ROOM_REFRESH_MS);
    if (state.gameTimer) clearInterval(state.gameTimer);
    state.gameTimer = setInterval(tickTimer, 1000);
  }

  function closeRoomListeners() {
    if (state.roomUnsub) state.roomUnsub();
    if (state.playersUnsub) state.playersUnsub();
    state.roomUnsub = state.playersUnsub = null;
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (state.gameTimer) clearInterval(state.gameTimer);
    state.refreshTimer = state.gameTimer = null;
  }

  function initMap() {
    if (!window.L) return;
    // The game panel is initially hidden. Recalculate Leaflet dimensions when the panel opens.
    if (state.map) {
      setTimeout(function () { if (state.map) state.map.invalidateSize(); }, 300);
      return;
    }
    state.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([52.1, 19.4], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.map);
    L.control.zoom({ position: 'bottomright' }).addTo(state.map);
    state.map.on('click', function (event) {
      if (!state.room || !state.roomCode) return;
      if (state.room.status !== 'lobby') {
        toast('Arena zablokowana', 'Środek areny można zmienić tylko w poczekalni.', 'error');
        return;
      }
      if (state.room.hostUid !== state.uid) {
        toast('Arenę ustawia host', 'Poproś hosta, aby wskazał punkt na mapie na swoim telefonie.', 'error');
        return;
      }
      saveArenaCenter(event.latlng.lat, event.latlng.lng);
    });
    setTimeout(function () { state.map.invalidateSize(); }, 250);
  }
  function locationVisible(player) {
    if (!state.room) return false;
    if (state.room.status === 'lobby' || state.room.status === 'countdown') return player.uid === state.uid;
    if (player.uid === state.uid || player.role === 'seeker') return true;
    if (player.alive === false) return true;
    if (player.outsideArea && state.me && state.me.role === 'seeker') return true;
    if (state.room.status === 'lobby' || state.room.status === 'countdown' || state.room.status === 'escape') return false;
    if (state.room.status !== 'running') return true;
    const revealEvery = Math.max(10, Number(state.room.revealEverySeconds || 30));
    const revealFor = Math.max(3, Math.min(revealEvery, Number(state.room.revealDurationSeconds || 5)));
    const elapsed = Math.max(0, (Date.now() - Number(state.room.startedAtMs || 0)) / 1000);
    if (!state.room.startedAtMs) return false;
    return (elapsed % revealEvery) < revealFor;
  }
  function markerIcon(player) {
    const isMe = player.uid === state.uid;
    let cls = player.role === 'seeker' ? 'seeker' : 'runner';
    if (isMe) cls = 'you';
    const title = isMe ? 'Ty' : (player.name || 'Gracz');
    return L.divIcon({ className: 'huntly-marker-shell', html: '<span class="huntly-marker marker-' + cls + '"></span><span class="marker-label">' + escapeHtml(title) + '</span>', iconSize: [22, 22], iconAnchor: [11, 11] });
  }
  function renderMap() {
    if (!state.map) return;
    if (state.room && typeof state.room.areaCenterLat === 'number' && typeof state.room.areaCenterLng === 'number') {
      const center = [state.room.areaCenterLat, state.room.areaCenterLng];
      const radius = currentZoneRadius(state.room, Date.now());
      if (!state.areaCircle) state.areaCircle = L.circle(center, { radius: radius, color: '#c7f36b', weight: 2, opacity: 0.9, fillColor: '#c7f36b', fillOpacity: 0.07 }).addTo(state.map);
      else state.areaCircle.setLatLng(center).setRadius(radius);
    }
    const visible = state.players.filter(function (p) { return typeof p.lat === 'number' && typeof p.lng === 'number' && locationVisible(p); });
    const keep = new Set();
    visible.forEach(function (player) {
      keep.add(player.uid);
      const latlng = [player.lat, player.lng];
      let marker = state.markers.get(player.uid);
      if (!marker) {
        marker = L.marker(latlng, { icon: markerIcon(player), riseOnHover: true }).addTo(state.map);
        state.markers.set(player.uid, marker);
      } else {
        marker.setLatLng(latlng);
        marker.setIcon(markerIcon(player));
      }
      marker.bindPopup('<strong>' + escapeHtml(player.name || 'Gracz') + '</strong><br>' + (player.role === 'seeker' ? 'Szukający' : 'Uciekający') + (player.alive === false ? '<br>Złapany' : ''));
    });
    state.markers.forEach(function (marker, uid) {
      if (!keep.has(uid)) { state.map.removeLayer(marker); state.markers.delete(uid); }
    });
    if (state.gps && !state.mapHasCentered) {
      state.map.setView([state.gps.lat, state.gps.lng], 15);
      state.mapHasCentered = true;
    }
    if (visible.length) $('mapUpdated').textContent = 'Widoczne pozycje: ' + visible.length;
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]; });
  }

  function renderPlayers() {
    const list = $('playersList');
    if (!list) return;
    syncPlayerCounts();
    list.innerHTML = '';
    const rolePending = !state.room || state.room.status === 'lobby';
    const roleReveal = !!(state.room && state.room.status === 'countdown');
    const players = state.players.slice().sort(function (a, b) {
      if (a.uid === state.uid) return -1;
      if (b.uid === state.uid) return 1;
      if (!rolePending && a.role === 'seeker') return -1;
      if (!rolePending && b.role === 'seeker') return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    players.forEach(function (player) {
      const row = document.createElement('div');
      row.className = 'player-row' + (player.alive === false ? ' player-caught' : '');
      const icon = document.createElement('div');
      icon.className = 'player-avatar ' + (rolePending || roleReveal ? 'avatar-pending' : (player.role === 'seeker' ? 'avatar-seeker' : 'avatar-runner'));
      icon.textContent = rolePending ? '?' : (roleReveal ? '…' : (player.role === 'seeker' ? '⌖' : '↗'));
      const info = document.createElement('div');
      info.className = 'player-info';
      const name = document.createElement('strong');
      name.textContent = (player.name || 'Gracz') + (player.uid === state.uid ? ' (Ty)' : '');
      const role = document.createElement('span');
      role.textContent = rolePending ? 'Rola losowana przy starcie' : (roleReveal ? 'Rola wylosowana' : (player.alive === false ? 'Złapany' : (player.outsideArea && state.me && state.me.role === 'seeker' ? 'Poza obszarem • GPS na żywo' : (player.role === 'seeker' ? 'Szukający' : 'Uciekający'))));
      info.appendChild(name); info.appendChild(role);
      row.appendChild(icon); row.appendChild(info);
      if (state.me && state.me.role === 'seeker' && player.role === 'runner' && player.alive !== false && state.room && state.room.status === 'running') {
        const readiness = captureReadiness(state.me, player, Date.now());
        const catchBtn = document.createElement('button');
        catchBtn.className = 'catch-button' + (readiness.ok ? ' catch-ready' : '');
        catchBtn.textContent = readiness.ok ? 'Przytrzymaj 2 s' : readiness.label;
        catchBtn.title = readiness.ok
          ? 'Przytrzymaj przez 2 sekundy. Odległość około ' + readiness.distance.toFixed(1) + ' m.'
          : readiness.message;
        catchBtn.disabled = !readiness.ok;
        catchBtn.setAttribute('aria-label', 'Złapanie gracza ' + (player.name || 'Gracz') + ': ' + (readiness.ok ? 'przytrzymaj przez 2 sekundy' : readiness.label));
        catchBtn.addEventListener('pointerdown', function (event) {
          if (event.pointerType) event.preventDefault();
          if (typeof catchBtn.setPointerCapture === 'function' && event.pointerId !== undefined) {
            try { catchBtn.setPointerCapture(event.pointerId); } catch (_) {}
          }
          startCaptureHold(player, catchBtn);
        });
        ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture', 'blur'].forEach(function (eventName) {
          catchBtn.addEventListener(eventName, function () { cancelCaptureHold(player.uid); });
        });
        catchBtn.addEventListener('keydown', function (event) {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault();
            startCaptureHold(player, catchBtn);
          }
        });
        catchBtn.addEventListener('keyup', function (event) {
          if (event.key === ' ' || event.key === 'Enter') cancelCaptureHold(player.uid);
        });
        row.appendChild(catchBtn);
      }
      list.appendChild(row);
    });
  }

  async function catchPlayer(player, nonce) {
    if (!state.roomCode || !state.uid) return;
    try {
      await captureApi('finish', { roomCode: state.roomCode, runnerUid: player.uid, nonce: nonce });
      toast('Gracz złapany!', (player.name || 'Gracz') + ' dołącza do drużyny szukających.', 'success');
    } catch (error) {
      toast('Nie udało się złapać gracza', error.message || friendlyError(error), 'error');
    }
  }

  async function startGame() {
    if (!state.room || state.room.hostUid !== state.uid || state.room.status !== 'lobby') return;
    try {
      await ensureLocation();
      const roomRef = state.db.collection('rooms').doc(state.roomCode);
      const liveSnap = await roomRef.collection('players').get();
      const roster = liveSnap.docs.map(function (doc) {
        const data = doc.data();
        data.uid = doc.id;
        return data;
      });
      if (roster.length < 2) {
        toast('Za mało graczy', 'Do rozpoczęcia potrzebujesz co najmniej dwóch osób.', 'error');
        return;
      }
      if (roster.length > 450) {
        toast('Za dużo graczy', 'Pokój przekroczył limit bezpiecznego losowania. Zmniejsz liczbę graczy.', 'error');
        return;
      }
      const seekerCount = Math.max(1, Number($('seekerCount').value) || 1);
      if (seekerCount >= roster.length) {
        toast('Za dużo szukających', 'Musi zostać co najmniej jedna osoba chowająca się. Zmień liczbę szukających.', 'error');
        return;
      }
      const escapeSeconds = Number($('escapeSeconds').value) || 30;
      const roundMinutes = Number($('roundMinutes').value) || 20;
      const revealEverySeconds = Number($('revealEverySeconds').value) || 30;
      const revealDurationSeconds = Number($('revealDurationSeconds').value) || 5;
      const areaRadiusMeters = Math.max(50, Number($('areaRadiusMeters').value) || 500);
      const zoneShrinkEnabled = $('zoneShrinkEnabled').value === 'on';
      const desiredFinalRadius = Math.max(50, Number($('zoneFinalRadiusMeters').value) || 100);
      const zoneFinalRadiusMeters = Math.min(desiredFinalRadius, Math.max(50, areaRadiusMeters * 0.75));
      const now = Date.now();
      const randomized = shufflePlayers(roster);
      const roleByUid = new Map();
      randomized.forEach(function (player, index) {
        roleByUid.set(player.uid, index < seekerCount ? 'seeker' : 'runner');
      });
      const batch = state.db.batch();
      roster.forEach(function (player) {
        batch.update(roomRef.collection('players').doc(player.uid), {
          role: roleByUid.get(player.uid),
          alive: true
        });
      });
      const countdownEndsAtMs = now + 3000;
      const roleRevealEndsAtMs = now + 5400;
      const escapeEndsAtMs = roleRevealEndsAtMs + escapeSeconds * 1000;
      const roundEndsAtMs = escapeEndsAtMs + roundMinutes * 60 * 1000;
      batch.update(roomRef, {
        status: 'countdown',
        seekerUids: randomized.slice(0, seekerCount).map(function (player) { return player.uid; }),
        countdownStartedAtMs: now,
        countdownEndsAtMs: countdownEndsAtMs,
        roleRevealEndsAtMs: roleRevealEndsAtMs,
        escapeSeconds: escapeSeconds,
        roundMinutes: roundMinutes,
        seekerCount: seekerCount,
        startedAtMs: escapeEndsAtMs,
        escapeEndsAtMs: escapeEndsAtMs,
        roundEndsAtMs: roundEndsAtMs,
        revealEverySeconds: revealEverySeconds,
        revealDurationSeconds: revealDurationSeconds,
        areaRadiusMeters: areaRadiusMeters,
        zoneShrinkEnabled: zoneShrinkEnabled,
        zoneFinalRadiusMeters: zoneFinalRadiusMeters,
        zoneShrinkStartAtMs: escapeEndsAtMs,
        zoneShrinkDurationSeconds: roundMinutes * 60,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
      state.players = roster.map(function (player) {
        return Object.assign({}, player, { role: roleByUid.get(player.uid), alive: true });
      });
      state.me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
      renderPlayers();
      renderMap();
      toast('Role wylosowane', 'Szukających: ' + seekerCount + ' • Chowających: ' + (roster.length - seekerCount) + '. Start za chwilę!', 'success');
    } catch (error) {
      toast('Nie udało się rozpocząć gry', friendlyError(error), 'error');
    }
  }

  function syncStartSequence(now) {
    const overlay = $('startSequenceOverlay');
    if (!overlay) return;
    if (!state.room || state.room.status !== 'countdown') {
      overlay.classList.add('hidden');
      overlay.classList.remove('is-visible', 'is-role-stage', 'is-seeker', 'is-runner');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.dataset.stageKey = '';
      return;
    }

    const countdownEndsAt = Number(state.room.countdownEndsAtMs) || (Number(state.room.countdownStartedAtMs) || now) + 3000;
    const inCountdown = now < countdownEndsAt;
    const me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
    const isSeeker = Array.isArray(state.room.seekerUids)
      ? state.room.seekerUids.includes(state.uid)
      : !!(me && me.role === 'seeker');
    const count = Math.max(1, Math.ceil((countdownEndsAt - now) / 1000));
    const stageKey = inCountdown ? 'count-' + count : 'role-' + (isSeeker ? 'seeker' : 'runner');

    overlay.classList.remove('hidden');
    overlay.classList.add('is-visible');
    overlay.setAttribute('aria-hidden', 'false');
    if (overlay.dataset.stageKey === stageKey) return;
    overlay.dataset.stageKey = stageKey;

    const kicker = $('startSequenceKicker');
    const number = $('startSequenceNumber');
    const title = $('startSequenceTitle');
    const message = $('startSequenceMessage');
    const symbol = $('startSequenceSymbol');

    overlay.classList.toggle('is-role-stage', !inCountdown);
    overlay.classList.toggle('is-seeker', !inCountdown && isSeeker);
    overlay.classList.toggle('is-runner', !inCountdown && !isSeeker);

    if (inCountdown) {
      kicker.textContent = 'HUNTLY • START ZA CHWILĘ';
      number.textContent = String(count);
      title.textContent = 'Przygotuj się';
      message.textContent = 'Role zostały wylosowane. Za moment ruszamy.';
      symbol.textContent = 'H';
      number.classList.remove('sequence-pop');
      void number.offsetWidth;
      number.classList.add('sequence-pop');
      return;
    }

    number.textContent = '';
    symbol.textContent = isSeeker ? '⌖' : '↗';
    kicker.textContent = isSeeker ? 'TWOJA ROLA • SZUKAJĄCY' : 'TWOJA ROLA • UCIEKAJĄCY';
    title.textContent = isSeeker
      ? (Number(state.room.seekerCount) > 1 ? 'JESTEŚ W DRUŻYNIE SZUKAJĄCYCH!' : 'ZOSTAŁEŚ SZUKAJĄCYM!')
      : 'JESTEŚ UCIEKAJĄCYM!';
    message.textContent = isSeeker
      ? 'Przygotuj się do pościgu. Czas ucieczki zaraz się rozpocznie.'
      : 'UCIEKAJ!!! Znajdź kryjówkę, zanim szukający ruszą za Tobą.';
  }

  function tickTimer() {
    if (!state.room) return;
    const now = Date.now();
    if (state.room.status !== 'countdown') state.countdownTransitionKey = null;

    if (state.room.status === 'countdown') {
      syncStartSequence(now);
      const revealEndsAt = Number(state.room.roleRevealEndsAtMs) || ((Number(state.room.countdownEndsAtMs) || now) + 2400);
      $('timer').textContent = formatTime(Math.max(0, Math.ceil((revealEndsAt - now) / 1000)));
      $('statusHint').textContent = 'Odliczanie do rozpoczęcia ucieczki.';
      const transitionKey = String(state.roomCode) + ':' + String(revealEndsAt);
      if (now >= revealEndsAt && state.room.hostUid === state.uid && state.countdownTransitionKey !== transitionKey) {
        state.countdownTransitionKey = transitionKey;
        state.db.collection('rooms').doc(state.roomCode).update({
          status: 'escape',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function (error) {
          console.warn('Countdown transition:', error);
          toast('Nie udało się przejść do fazy ucieczki', friendlyError(error), 'error');
          setTimeout(function () {
            if (state.room && state.room.status === 'countdown' && state.countdownTransitionKey === transitionKey) {
              state.countdownTransitionKey = null;
            }
          }, 3000);
        });
      }
    } else if (state.room.status === 'escape') {
      syncStartSequence(now);
      const remaining = Math.max(0, Math.ceil(((state.room.escapeEndsAtMs || now) - now) / 1000));
      $('timer').textContent = formatTime(remaining);
      $('statusHint').textContent = 'Ukryj się, zanim skończy się czas.';
      if (remaining <= 0 && state.room.hostUid === state.uid) {
        state.db.collection('rooms').doc(state.roomCode).update({ status: 'running', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(function () {});
      }
    } else if (state.room.status === 'running') {
      const remaining = Math.max(0, Math.ceil(((state.room.roundEndsAtMs || now) - now) / 1000));
      $('timer').textContent = formatTime(remaining);
      const elapsed = state.room.startedAtMs ? Math.max(0, Math.floor((now - state.room.startedAtMs) / 1000)) : 0;
      const every = Math.max(5, Number(state.room.revealEverySeconds) || 30);
      const duration = Math.min(every, Math.max(1, Number(state.room.revealDurationSeconds) || 5));
      const reveal = state.room.status === 'running' && elapsed % every < duration;
      let hint = reveal ? '⚠ Sygnał GPS — pozycje ujawnione!' : 'Pozycje uciekających są ukryte.';
      if (state.room.zoneShrinkEnabled) hint += ' • Strefa: ' + Math.round(currentZoneRadius(state.room, now)) + ' m';
      $('statusHint').textContent = hint;
      if (remaining <= 0 && state.room.hostUid === state.uid) finishRoom('Czas się skończył.');
      renderMap();
    } else {
      syncStartSequence(now);
      $('timer').textContent = state.room.status === 'ended' ? '00:00' : '--:--';
      $('statusHint').textContent = state.room.status === 'lobby' ? 'Czekamy na start.' : 'Rozgrywka zakończona.';
    }
  }
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  async function finishRoom(message) {
    if (!state.roomCode || !state.room || state.room.status === 'ended') return;
    try {
      await state.db.collection('rooms').doc(state.roomCode).update({ status: 'ended', endedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      toast('Koniec gry', message || 'Runda zakończona.', 'success');
    } catch (error) { console.warn('finish room:', error); }
  }
  async function leaveRoom() {
    const code = state.roomCode;
    if (!code) return;
    if (!confirm('Na pewno chcesz opuścić pokój?')) return;
    try {
      await state.db.collection('rooms').doc(code).collection('players').doc(state.uid).delete();
      const roomRef = state.db.collection('rooms').doc(code);
      const snap = await roomRef.get();
      if (snap.exists && snap.data().hostUid === state.uid) {
        const next = state.players.find(function (p) { return p.uid !== state.uid; });
        if (next) {
          await roomRef.update({ hostUid: next.uid, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        } else {
          await roomRef.update({ status: 'ended', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }
      }
      exitRoom(true);
    } catch (error) { toast('Nie udało się opuścić pokoju', friendlyError(error), 'error'); }
  }
  function exitRoom(clear) {
    closeRoomListeners();
    stopGps();
    if (state.map) { state.map.remove(); state.map = null; state.mapHasCentered = false; }
    state.markers.clear();
    state.roomCode = null; state.room = null; state.me = null; state.players = [];
    if (clear !== false) clearSession();
    showWelcome();
  }

  async function copyCode() {
    if (!state.roomCode) return;
    try {
      await navigator.clipboard.writeText(state.roomCode);
      toast('Kod skopiowany', state.roomCode, 'success');
    } catch (error) {
      const input = document.createElement('textarea');
      input.value = state.roomCode; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
      toast('Kod skopiowany', state.roomCode, 'success');
    }
  }


  function setupInstallRequirement() {
    const gate = $('installGate');
    const installBtn = $('installAppBtn');
    const checkBtn = $('checkInstalledBtn');
    const status = $('installStatus');
    const iosGuide = $('iosInstallGuide');
    const iosGuideBack = $('iosGuideBack');
    let installPrompt = null;
    const openIosInstallGuide = function () {
      gate.classList.add('ios-guide-open');
      iosGuide.classList.remove('hidden');
      iosGuide.setAttribute('aria-hidden', 'false');
      status.textContent = 'Postępuj zgodnie z instrukcją wyświetloną na całym ekranie.';
    };
    const closeIosInstallGuide = function () {
      gate.classList.remove('ios-guide-open');
      iosGuide.classList.add('hidden');
      iosGuide.setAttribute('aria-hidden', 'true');
    };
    iosGuideBack.addEventListener('click', closeIosInstallGuide);
    const isInstalled = function () {
      return window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.navigator.standalone === true;
    };
    const unlockIfInstalled = function () {
      if (isInstalled()) {
        gate.classList.add('hidden');
        document.body.classList.add('pwa-installed');
        return true;
      }
      gate.classList.remove('hidden');
      document.body.classList.remove('pwa-installed');
      return false;
    };
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      installPrompt = event;
      installBtn.disabled = false;
      installBtn.innerHTML = 'Zainstaluj Huntly <span class="button-arrow">↗</span>';
      $('installInstructionTitle').textContent = 'Instalacja jednym kliknięciem';
      $('installInstructionText').textContent = 'Naciśnij przycisk powyżej i zatwierdź instalację w oknie przeglądarki.';
    });
    window.addEventListener('appinstalled', function () {
      installPrompt = null;
      status.textContent = 'Instalacja zakończona. Otwórz Huntly z nowej ikony aplikacji.';
      unlockIfInstalled();
    });
    installBtn.addEventListener('click', async function () {
      if (isInstalled()) { unlockIfInstalled(); return; }
      if (installPrompt) {
        installBtn.disabled = true;
        installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        installPrompt = null;
        installBtn.disabled = false;
        if (choice && choice.outcome === 'accepted') {
          status.textContent = 'Zatwierdzono instalację. Otwórz Huntly z ikony na ekranie głównym.';
        } else {
          status.textContent = 'Instalacja nie została zatwierdzona. Jest wymagana, aby grać.';
        }
        return;
      }
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const android = /android/i.test(navigator.userAgent);
      if (ios) {
        $('installInstructionTitle').textContent = 'iPhone / iPad — Safari';
        $('installInstructionText').textContent = 'Otwórz stronę w Safari (nie w przeglądarce wbudowanej w inną aplikację). Naciśnij Udostępnij, wybierz „Dodaj do ekranu początkowego”, a następnie „Dodaj”. Potem uruchom Huntly z nowej ikony.';
        status.textContent = 'Po dodaniu ikony zamknij tę kartę i uruchom aplikację z ekranu początkowego.';
        openIosInstallGuide();
      } else if (android) {
        $('installInstructionTitle').textContent = 'Android — Chrome';
        $('installInstructionText').textContent = 'Otwórz menu ⋮ w Chrome i wybierz „Zainstaluj aplikację” lub „Dodaj do ekranu głównego”. Potwierdź, a potem uruchom Huntly z ikony.';
        status.textContent = 'Po instalacji uruchom Huntly z ekranu głównego.';
      } else {
        $('installInstructionTitle').textContent = 'Komputer — Chrome / Edge';
        $('installInstructionText').textContent = 'Użyj ikony instalacji w pasku adresu albo menu przeglądarki → „Zainstaluj Huntly”. Niektóre przeglądarki komputerowe nie obsługują instalacji PWA.';
        status.textContent = 'Aby grać, otwórz aplikację w trybie samodzielnym po instalacji.';
      }
    });
    checkBtn.addEventListener('click', function () {
      if (!unlockIfInstalled()) {
        status.textContent = 'Nie wykryto trybu aplikacji. Otwórz Huntly z ikony dodanej do ekranu głównego — samo potwierdzenie nie odblokuje gry.';
      }
    });
    window.addEventListener('pageshow', unlockIfInstalled);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) unlockIfInstalled();
    });
    unlockIfInstalled();
  }

  function wireUi() {
    $('createBtn').addEventListener('click', createRoom);
    $('joinBtn').addEventListener('click', joinRoom);
    $('enableLocationBtn').addEventListener('click', function () {
      ensureLocation().then(function () { toast('GPS gotowy', 'Lokalizacja została uzyskana.', 'success'); }).catch(function (error) { toast('Lokalizacja wymagana', error.message, 'error'); });
    });
    $('startBtn').addEventListener('click', startGame);
    $('arenaAtMeBtn').addEventListener('click', async function () {
      if (!canEditArena()) {
        toast('Arenę ustawia host', 'Otwórz poczekalnię na telefonie hosta, aby zmienić środek areny.', 'error');
        return;
      }
      const button = this;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = 'Pobieram GPS…';
      try {
        await ensureLocation();
        if (!state.gps) throw new Error('Nie udało się odczytać GPS.');
        await saveArenaCenter(state.gps.lat, state.gps.lng);
      } catch (error) {
        toast('Nie udało się ustawić areny', error.message || friendlyError(error), 'error');
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    });
    $('areaRadiusMeters').addEventListener('change', function () {
      if (state.room && state.room.hostUid === state.uid && state.room.status === 'lobby') {
        const radius = Math.max(50, Number(this.value) || 500);
        state.room.areaRadiusMeters = radius;
        renderMap();
        state.db.collection('rooms').doc(state.roomCode).update({
          areaRadiusMeters: radius,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function (error) {
          toast('Nie udało się zapisać promienia', friendlyError(error), 'error');
        });
      }
    });
    $('seekerCount').addEventListener('change', function () {
      const count = Math.max(1, Math.min(4, Number(this.value) || 1));
      this.value = String(count);
      if (state.room && state.room.hostUid === state.uid && state.room.status === 'lobby') {
        state.room.seekerCount = count;
        state.db.collection('rooms').doc(state.roomCode).update({
          seekerCount: count,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function (error) {
          toast('Nie udało się zapisać liczby szukających', friendlyError(error), 'error');
        });
      }
      updateStartButton();
    });
    $('zoneShrinkEnabled').addEventListener('change', function () {
      if (state.room && state.room.hostUid === state.uid && state.room.status === 'lobby') {
        const enabled = this.value === 'on';
        state.room.zoneShrinkEnabled = enabled;
        state.db.collection('rooms').doc(state.roomCode).update({
          zoneShrinkEnabled: enabled,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function (error) {
          toast('Nie udało się zapisać ustawienia strefy', friendlyError(error), 'error');
        });
      }
    });
    $('zoneFinalRadiusMeters').addEventListener('change', function () {
      if (state.room && state.room.hostUid === state.uid && state.room.status === 'lobby') {
        const radius = Math.max(50, Number(this.value) || 100);
        state.room.zoneFinalRadiusMeters = radius;
        state.db.collection('rooms').doc(state.roomCode).update({
          zoneFinalRadiusMeters: radius,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function (error) {
          toast('Nie udało się zapisać promienia końcowego', friendlyError(error), 'error');
        });
      }
    });
    $('leaveBtn').addEventListener('click', leaveRoom);
    $('endBtn').addEventListener('click', function () { if (confirm('Zakończyć rundę?')) finishRoom('Host zakończył rundę.'); });
    $('copyCodeBtn').addEventListener('click', copyCode);
    $('roomCode').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.roomCode) {
        if (!state.locationReady) ensureLocation().then(updateMyPosition).catch(function () {});
        if (state.db) state.db.collection('rooms').doc(state.roomCode).get().then(function (snap) { if (snap.exists) state.room = snap.data(); }).catch(function () {});
      }
    });
    window.addEventListener('online', function () { setConnection('FIREBASE ONLINE', true); });
    window.addEventListener('offline', function () { setConnection('BRAK INTERNETU', false); });
  }

  setupInstallRequirement();
  wireUi();
  initMap();
  state.authReady = initFirebase().then(function () {
    restoreSession();
  }).catch(function (error) {
    setConnection('BRAK POŁĄCZENIA', false);
    toast('Błąd uruchamiania Huntly', friendlyError(error), 'error');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function (error) { console.warn('Service worker:', error); });
    });
  }
})();