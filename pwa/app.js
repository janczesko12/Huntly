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
    app: null, auth: null, db: null, uid: null, roomCode: null, room: null, me: null,
    players: [], roomUnsub: null, playersUnsub: null, map: null, markers: new Map(),
    gps: null, gpsWatch: null, gpsTimer: null, refreshTimer: null, gameTimer: null,
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
          accuracy: position.coords.accuracy || null,
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
    ref.update({
      lat: state.gps.lat,
      lng: state.gps.lng,
      accuracy: state.gps.accuracy,
      locationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      onlineAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function (error) {
      if (error.code !== 'not-found') console.warn('GPS sync:', error);
    });
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
    state.gps = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy || null, updatedAt: Date.now() };
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
      tickTimer();
    }, function (error) { toast('Błąd synchronizacji pokoju', friendlyError(error), 'error'); });
    state.playersUnsub = ref.collection('players').onSnapshot(function (snap) {
      state.players = snap.docs.map(function (doc) { const d = doc.data(); d.uid = doc.id; return d; });
      state.me = state.players.find(function (player) { return player.uid === state.uid; }) || state.me;
      if (state.me) sessionStore();
      renderPlayers();
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
      role.textContent = player.role === 'seeker' ? 'Szukający' : (player.alive === false ? 'Złapany' : 'Uciekający');
      info.appendChild(name); info.appendChild(role);
      row.appendChild(icon); row.appendChild(info);
      if (state.me && state.me.role === 'seeker' && player.role === 'runner' && player.alive !== false && state.room && state.room.status === 'running') {
        const catchBtn = document.createElement('button');
        catchBtn.className = 'catch-button';
        catchBtn.textContent = 'Złap';
        catchBtn.title = 'Oznacz gracza jako złapanego';
        catchBtn.addEventListener('click', function () { catchPlayer(player); });
        row.appendChild(catchBtn);
      }
      list.appendChild(row);
    });
  }

  async function catchPlayer(player) {
    if (!confirm('Oznaczyć gracza ' + (player.name || 'Gracz') + ' jako złapanego?')) return;
    try {
      await state.db.collection('rooms').doc(state.roomCode).collection('players').doc(player.uid).update({ alive: false, caughtAt: firebase.firestore.FieldValue.serverTimestamp() });
      toast('Gracz złapany', player.name || 'Gracz', 'success');
      const runners = state.players.filter(function (p) { return p.role === 'runner' && p.alive !== false && p.uid !== player.uid; });
      if (!runners.length) await finishRoom('Szukający wygrywa — wszyscy uciekający zostali złapani.');
    } catch (error) { toast('Nie udało się oznaczyć złapania', friendlyError(error), 'error'); }
  }

  async function startGame() {
    if (!state.room || state.room.hostUid !== state.uid) return;
    if (state.players.length < 2) { toast('Za mało graczy', 'Do rozpoczęcia potrzebujesz co najmniej dwóch osób.', 'error'); return; }
    try {
      await ensureLocation();
      const escapeSeconds = Number($('escapeSeconds').value) || 30;
      const roundMinutes = Number($('roundMinutes').value) || 20;
      const now = Date.now();
      await state.db.collection('rooms').doc(state.roomCode).update({
        status: 'escape', escapeSeconds: escapeSeconds, roundMinutes: roundMinutes,
        startedAtMs: now, escapeEndsAtMs: now + escapeSeconds * 1000,
        roundEndsAtMs: now + (escapeSeconds + roundMinutes * 60) * 1000,
        revealEverySeconds: 30, revealDurationSeconds: 5,
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
      const reveal = state.room.status === 'running' && elapsed % 30 < 5;
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

  function wireUi() {
    $('createBtn').addEventListener('click', createRoom);
    $('joinBtn').addEventListener('click', joinRoom);
    $('enableLocationBtn').addEventListener('click', function () {
      ensureLocation().then(function () { toast('GPS gotowy', 'Lokalizacja została uzyskana.', 'success'); }).catch(function (error) { toast('Lokalizacja wymagana', error.message, 'error'); });
    });
    $('startBtn').addEventListener('click', startGame);
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
      navigator.serviceWorker.register('/sw.js').catch(function (error) { console.warn('Service worker:', error); });
    });
  }
})();