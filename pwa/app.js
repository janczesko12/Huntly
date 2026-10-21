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
  const GPS_INTERVAL_MS = 10000;
  const ROOM_REFRESH_MS = 10000;
  const $ = function (id) { return document.getElementById(id); };
  const state = {
    app: null, auth: null, db: null, functions: null, uid: null, roomCode: null, room: null, me: null,
    players: [], roomUnsub: null, playersUnsub: null, map: null, markers: new Map(),
    gps: null, gpsWatch: null, gpsTimer: null, refreshTimer: null, gameTimer: null, areaCircle: null,
    roomBusy: false, locationReady: false, lastGpsAt: 0, lastRoomUpdate: 0
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
    state.functions = firebase.app().functions('europe-west1');
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

  function cancelCaptureHold(uid) {
    const hold = state.captureHolds.get(uid);
    if (!hold) return;
    clearInterval(hold.interval);
    state.captureHolds.delete(uid);
    if (hold.button) {
      hold.button.classList.remove('is-holding');
      hold.button.style.removeProperty('--hold-progress');
      hold.button.textContent = 'Przytrzymaj 2 s';
      hold.button.disabled = false;
    }
  }

  function startCaptureHold(player, button) {
    if (state.captureHolds.has(player.uid)) return;
    const readiness = captureReadiness(state.me, player, Date.now());
    if (!readiness.ok) {
      toast('Nie można jeszcze złapać', readiness.message, 'error');
      renderPlayers();
      return;
    }
    const startedAt = Date.now();
    button.classList.add('is-holding');
    button.style.setProperty('--hold-progress', '0%');
    button.textContent = 'Trzymaj 2.0 s';
    const interval = setInterval(function () {
      const current = state.players.find(function (p) { return p.uid === player.uid; }) || player;
      const allowed = state.room && state.room.status === 'running' && state.me && state.me.role === 'seeker' &&
        current.role === 'runner' && current.alive !== false && captureReadiness(state.me, current, Date.now()).ok;
      if (!allowed) {
        cancelCaptureHold(player.uid);
        toast('Przerwano łapanie', 'Gracz wyszedł z zasięgu albo GPS jest nieaktualny.', 'error');
        renderPlayers();
        return;
      }
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(1, elapsed / CAPTURE_HOLD_MS);
      const remaining = Math.max(0, (CAPTURE_HOLD_MS - elapsed) / 1000);
      button.style.setProperty('--hold-progress', (progress * 100).toFixed(1) + '%');
      button.textContent = progress >= 1 ? 'Sprawdzam…' : 'Trzymaj ' + remaining.toFixed(1) + ' s';
      if (progress >= 1) {
        clearInterval(interval);
        state.captureHolds.delete(player.uid);
        button.classList.remove('is-holding');
        button.style.removeProperty('--hold-progress');
        button.disabled = true;
        catchPlayer(current).finally(function () { renderPlayers(); });
      }
    }, 50);
    state.captureHolds.set(player.uid, { interval: interval, button: button });
  }

  function isOutsidePlayArea(position, room) {
    if (!room || typeof room.areaCenterLat !== 'number' || typeof room.areaCenterLng !== 'number') return false;
    const radius = Math.max(50, Number(room.areaRadiusMeters) || 500);
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
      if (room.status === 'ended') throw new Error('Ta rozgrywka jest już zakończona.');
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

  function openRoom(code) {
    closeRoomListeners();
    state.roomCode = code;
    const ref = state.db.collection('rooms').doc(code);
    showGame();
    $('roomCodeDisplay').textContent = code;
    $('roomTitle').innerHTML = 'Pokój <em>' + code + '</em>';
    $('roleBadge').textContent = state.me && state.me.role === 'seeker' ? 'SZUKAJĄCY' : 'UCIEKAJĄCY';
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
      $('roomSubtitle').textContent = state.room.status === 'lobby' ? 'Poczekalnia • zaproś znajomych' : state.room.status === 'escape' ? 'Uciekający mają czas na ukrycie się' : state.room.status === 'running' ? 'Runda trwa — powodzenia!' : 'Rozgrywka zakończona';
      $('gameStatus').textContent = ({ lobby: 'Poczekalnia', escape: 'Czas ucieczki', running: 'W trakcie gry', ended: 'Koniec rundy' })[state.room.status] || state.room.status;
      const isHost = state.room.hostUid === state.uid;
      $('hostControls').classList.toggle('hidden', !isHost || state.room.status !== 'lobby');
      $('startBtn').disabled = !isHost || state.players.length < 2;
      $('gameActions').classList.toggle('hidden', state.room.status === 'lobby' || state.room.status === 'ended');
      $('escapeSeconds').value = String(state.room.escapeSeconds || 30);
      $('roundMinutes').value = String(state.room.roundMinutes || 20);
      $('areaRadiusMeters').value = String(state.room.areaRadiusMeters || 500);
      tickTimer();
    }, function (error) { toast('Błąd synchronizacji pokoju', friendlyError(error), 'error'); });
    state.playersUnsub = ref.collection('players').onSnapshot(function (snap) {
      state.players = snap.docs.map(function (doc) { const d = doc.data(); d.uid = doc.id; return d; });
      state.me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
      if (state.me) {
        sessionStore();
        $('roleBadge').textContent = state.me.role === 'seeker' ? 'SZUKAJĄCY' : 'UCIEKAJĄCY';
      }
      state.captureHolds.forEach(function (_, uid) {
        const target = state.players.find(function (p) { return p.uid === uid; });
        if (!target || target.role !== 'runner' || target.alive === false || !state.me || state.me.role !== 'seeker') cancelCaptureHold(uid);
      });
      if (state.captureHolds.size === 0) renderPlayers();
      renderMap();
      $('playerCount').textContent = state.players.length + (state.players.length === 1 ? ' gracz' : ' graczy');
      $('rosterCount').textContent = String(state.players.length);
      if (state.room && state.room.hostUid === state.uid && state.room.status === 'lobby') $('startBtn').disabled = state.players.length < 2;
      const runners = state.players.filter(function (p) { return p.role === 'runner' && p.alive !== false; }).length;
      if (state.room && state.room.status === 'running' && runners === 0) finishRoom('Szukający wygrywa — wszyscy uciekający zostali złapani.');
    }, function (error) { toast('Nie udało się pobrać graczy', friendlyError(error), 'error'); });
    beginGps();
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(function () {
      ref.get().then(function (snap) {
        if (snap.exists) state.room = snap.data();
        return ref.collection('players').get();
      }).then(function (snap) {
        state.players = snap.docs.map(function (doc) { const d = doc.data(); d.uid = doc.id; return d; });
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
    setTimeout(function () { state.map.invalidateSize(); }, 250);
  }
  function locationVisible(player) {
    if (!state.room) return false;
    if (player.uid === state.uid || player.role === 'seeker') return true;
    if (player.alive === false) return true;
    if (player.outsideArea && state.me && state.me.role === 'seeker') return true;
    if (state.room.status === 'lobby' || state.room.status === 'escape') return false;
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
      const radius = Math.max(50, Number(state.room.areaRadiusMeters) || 500);
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
    list.innerHTML = '';
    const players = state.players.slice().sort(function (a, b) {
      if (a.uid === state.uid) return -1;
      if (b.uid === state.uid) return 1;
      if (a.role === 'seeker') return -1;
      if (b.role === 'seeker') return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    players.forEach(function (player) {
      const row = document.createElement('div');
      row.className = 'player-row' + (player.alive === false ? ' player-caught' : '');
      const icon = document.createElement('div');
      icon.className = 'player-avatar ' + (player.role === 'seeker' ? 'avatar-seeker' : 'avatar-runner');
      icon.textContent = player.role === 'seeker' ? '⌖' : '↗';
      const info = document.createElement('div');
      info.className = 'player-info';
      const name = document.createElement('strong');
      name.textContent = (player.name || 'Gracz') + (player.uid === state.uid ? ' (Ty)' : '');
      const role = document.createElement('span');
      role.textContent = player.role === 'seeker' ? 'Szukający' : (player.alive === false ? 'Złapany' : (player.outsideArea && state.me && state.me.role === 'seeker' ? 'Poza obszarem • GPS na żywo' : 'Uciekający'));
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

  async function catchPlayer(player) {
    if (!state.roomCode || !state.uid) return;
    try {
      const capture = state.functions.httpsCallable('captureRunner');
      await capture({ roomCode: state.roomCode, runnerUid: player.uid });
      toast('Gracz złapany!', (player.name || 'Gracz') + ' dołącza do drużyny szukających.', 'success');
    } catch (error) {
      toast('Nie udało się złapać gracza', friendlyError(error), 'error');
    }
  }

  async function startGame() {
    if (!state.room || state.room.hostUid !== state.uid) return;
    if (state.players.length < 2) { toast('Za mało graczy', 'Do rozpoczęcia potrzebujesz co najmniej dwóch osób.', 'error'); return; }
    try {
      await ensureLocation();
      const escapeSeconds = Number($('escapeSeconds').value) || 30;
      const roundMinutes = Number($('roundMinutes').value) || 20;
      const revealEverySeconds = Number($('revealEverySeconds').value) || 30;
      const revealDurationSeconds = Number($('revealDurationSeconds').value) || 5;
      const areaRadiusMeters = Number($('areaRadiusMeters').value) || 500;
      const now = Date.now();
      await state.db.collection('rooms').doc(state.roomCode).update({
        status: 'escape', escapeSeconds: escapeSeconds, roundMinutes: roundMinutes,
        startedAtMs: now, escapeEndsAtMs: now + escapeSeconds * 1000,
        roundEndsAtMs: now + (escapeSeconds + roundMinutes * 60) * 1000,
        revealEverySeconds: revealEverySeconds, revealDurationSeconds: revealDurationSeconds,
        areaRadiusMeters: areaRadiusMeters,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      toast('Gra wystartowała', 'Uciekający mają ' + escapeSeconds + ' s na ukrycie się.', 'success');
    } catch (error) { toast('Nie udało się rozpocząć gry', friendlyError(error), 'error'); }
  }

  function tickTimer() {
    if (!state.room) return;
    const now = Date.now();
    if (state.room.status === 'escape') {
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
      $('statusHint').textContent = reveal ? '⚠ Sygnał GPS — pozycje ujawnione!' : 'Pozycje uciekających są ukryte.';
      if (remaining <= 0 && state.room.hostUid === state.uid) finishRoom('Czas się skończył.');
      renderMap();
    } else {
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
    let installPrompt = null;
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
    $('areaRadiusMeters').addEventListener('change', function () {
      if (state.room && state.room.hostUid === state.uid && state.room.status === 'lobby') {
        state.room.areaRadiusMeters = Number(this.value) || 500;
        renderMap();
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