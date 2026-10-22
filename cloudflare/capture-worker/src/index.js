import {
  CAPTURE_HOLD_MS,
  CAPTURE_HOLD_TTL_MS,
  validateCapture
} from './domain.js';

let cachedToken = null;
let tokenExpiresAt = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(origin ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
      } : {})
    }
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : '';
}

function encodeBase64Url(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < array.length; i++) binary += String.fromCharCode(array[i]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeTextBase64Url(value) {
  return encodeBase64Url(new TextEncoder().encode(value));
}

function pemToBytes(pem) {
  const body = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getGoogleAccessToken(env) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  let account;
  try {
    account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || '');
  } catch {
    throw new ApiError(500, 'Brak prawidłowego sekretu FIREBASE_SERVICE_ACCOUNT_JSON w Cloudflare.');
  }
  if (!account.client_email || !account.private_key || !account.project_id) {
    throw new ApiError(500, 'Konto serwisowe musi zawierać client_email, private_key i project_id.');
  }
  if (env.FIREBASE_PROJECT_ID && account.project_id !== env.FIREBASE_PROJECT_ID) {
    throw new ApiError(500, 'Konto serwisowe należy do innego projektu Firebase.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  if (account.private_key_id) header.kid = account.private_key_id;
  const claims = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const unsigned = encodeTextBase64Url(JSON.stringify(header)) + '.' + encodeTextBase64Url(JSON.stringify(claims));
  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToBytes(account.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    throw new ApiError(500, 'Nie udało się odczytać klucza prywatnego konta serwisowego.');
  }
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + encodeBase64Url(signature);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const tokenData = await response.json().catch(() => ({}));
  if (!response.ok || !tokenData.access_token) {
    throw new ApiError(502, 'Google nie wydał tokenu dla konta serwisowego.');
  }
  cachedToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
  return cachedToken;
}

async function verifyFirebaseIdToken(idToken, env) {
  if (!env.FIREBASE_WEB_API_KEY) throw new ApiError(500, 'Brak sekretu FIREBASE_WEB_API_KEY w Cloudflare.');
  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(env.FIREBASE_WEB_API_KEY),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  const result = await response.json().catch(() => ({}));
  const uid = result && result.users && result.users[0] && result.users[0].localId;
  if (!response.ok || !uid) throw new ApiError(401, 'Sesja Firebase jest nieprawidłowa lub wygasła.');
  return uid;
}

async function firestoreRequest(env, path, accessToken, body) {
  const url = 'https://firestore.googleapis.com/v1/projects/' +
    encodeURIComponent(env.FIREBASE_PROJECT_ID) + '/databases/(default)/documents' + path;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result && result.error && result.error.message;
    throw new ApiError(502, 'Firestore REST API: ' + (detail || ('HTTP ' + response.status)));
  }
  return result;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return value;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('nullValue' in value) return null;
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  return undefined;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]));
}

function encodeString(value) {
  return { stringValue: String(value) };
}

function encodeBoolean(value) {
  return { booleanValue: Boolean(value) };
}

function encodeTimestampMs(value) {
  return { timestampValue: new Date(value).toISOString() };
}

function parseBatchGet(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
}

async function beginReadTransaction(env, accessToken, names) {
  const started = await firestoreRequest(env, ':beginTransaction', accessToken, { options: { readWrite: {} } });
  const transaction = started.transaction;
  if (!transaction) throw new ApiError(502, 'Firestore nie rozpoczął transakcji.');

  try {
    const response = await fetch(
      'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(env.FIREBASE_PROJECT_ID) +
        '/databases/(default)/documents:batchGet',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: names, transaction })
      }
    );
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new ApiError(502, 'Nie udało się odczytać gry z Firestore' +
        (detail.error && detail.error.message ? ': ' + detail.error.message : '.'));
    }

    const records = parseBatchGet(await response.text());
    const documents = new Map();
    records.forEach(record => {
      if (record.found && record.found.name) {
        documents.set(record.found.name, { raw: record.found, data: decodeFields(record.found.fields || {}) });
      } else if (record.missing) {
        documents.set(record.missing, null);
      }
    });
    return { transaction, documents };
  } catch (error) {
    try { await firestoreRequest(env, ':rollback', accessToken, { transaction }); } catch {}
    throw error;
  }
}

async function commitTransaction(env, accessToken, transaction, writes) {
  await firestoreRequest(env, ':commit', accessToken, { transaction, writes });
}

async function rollbackTransaction(env, accessToken, transaction) {
  try { await firestoreRequest(env, ':rollback', accessToken, { transaction }); } catch {}
}

function getDoc(transaction, name, label) {
  const found = transaction.documents.get(name);
  if (!found) throw new ApiError(404, label + ' nie istnieje.');
  return found;
}

function validateGameState(room, seeker, runner, now) {
  if (room.status !== 'running') throw new ApiError(409, 'Łapanie jest możliwe tylko podczas aktywnej rundy.');
  if (seeker.role !== 'seeker' || seeker.alive === false) throw new ApiError(403, 'Tylko aktywny szukający może łapać.');
  if (runner.role !== 'runner' || runner.alive === false) throw new ApiError(409, 'Ten gracz nie jest już uciekającym.');
  const check = validateCapture(seeker, runner, now);
  if (!check.ok) throw new ApiError(409, check.message);
  return check;
}

async function handleAction(env, action, uid, input) {
  const roomCode = String(input.roomCode || '').trim();
  const runnerUid = String(input.runnerUid || '').trim();
  const nonce = String(input.nonce || '').trim();
  if (!/^\d{6}$/.test(roomCode) || !/^[A-Za-z0-9_-]{1,128}$/.test(runnerUid) || runnerUid === uid ||
      !/^[0-9a-f-]{32,36}$/i.test(nonce)) {
    throw new ApiError(400, 'Nieprawidłowy pokój, gracz lub identyfikator łapania.');
  }

  const holdId = uid + '_' + runnerUid;
  const roomName = 'projects/' + env.FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/rooms/' + roomCode;
  const seekerName = roomName + '/players/' + uid;
  const runnerName = roomName + '/players/' + runnerUid;
  const holdName = roomName + '/captureHolds/' + holdId;
  const accessToken = await getGoogleAccessToken(env);

  if (action === 'cancel') {
    const tx = await beginReadTransaction(env, accessToken, [holdName]);
    try {
      const hold = tx.documents.get(holdName);
      if (!hold || hold.data.seekerUid !== uid || hold.data.nonce !== nonce) {
        await rollbackTransaction(env, accessToken, tx.transaction);
        return { ok: true, cancelled: false };
      }
      await commitTransaction(env, accessToken, tx.transaction, [{ delete: holdName }]);
      return { ok: true, cancelled: true };
    } catch (error) {
      await rollbackTransaction(env, accessToken, tx.transaction);
      throw error;
    }
  }

  const tx = await beginReadTransaction(env, accessToken, [roomName, seekerName, runnerName, holdName]);
  try {
    const room = getDoc(tx, roomName, 'Pokój').data;
    const seeker = getDoc(tx, seekerName, 'Szukający').data;
    const runner = getDoc(tx, runnerName, 'Uciekający').data;
    const now = Date.now();
    const validation = validateGameState(room, seeker, runner, now);

    if (action === 'start') {
      const fields = {
        seekerUid: encodeString(uid),
        runnerUid: encodeString(runnerUid),
        nonce: encodeString(nonce),
        startedAt: encodeTimestampMs(now)
      };
      await commitTransaction(env, accessToken, tx.transaction, [{
        update: { name: holdName, fields },
        updateMask: { fieldPaths: ['seekerUid', 'runnerUid', 'nonce', 'startedAt'] }
      }]);
      return { ok: true, startedAt: now, distanceMeters: Math.round(validation.distanceMeters * 10) / 10 };
    }

    if (action === 'finish') {
      const hold = tx.documents.get(holdName);
      if (!hold || hold.data.seekerUid !== uid || hold.data.runnerUid !== runnerUid || hold.data.nonce !== nonce) {
        throw new ApiError(409, 'Czas przytrzymania wygasł albo został przerwany. Spróbuj ponownie.');
      }
      const startedAt = Number(hold.data.startedAt) || 0;
      if (now - startedAt < CAPTURE_HOLD_MS) throw new ApiError(409, 'Przytrzymaj jeszcze chwilę.');
      if (now - startedAt > CAPTURE_HOLD_TTL_MS) throw new ApiError(409, 'Przytrzymanie wygasło. Spróbuj ponownie.');

      await commitTransaction(env, accessToken, tx.transaction, [
        {
          update: {
            name: runnerName,
            fields: {
              role: encodeString('seeker'),
              alive: encodeBoolean(true),
              caught: encodeBoolean(true),
              caughtBy: encodeString(uid)
            }
          },
          updateMask: { fieldPaths: ['role', 'alive', 'caught', 'caughtBy'] },
          updateTransforms: [
            { fieldPath: 'caughtAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'joinedSeekerTeamAt', setToServerValue: 'REQUEST_TIME' }
          ]
        },
        { delete: holdName }
      ]);
      return {
        ok: true,
        distanceMeters: Math.round(validation.distanceMeters * 10) / 10,
        joinedTeam: 'seeker'
      };
    }

    throw new ApiError(404, 'Nieznana operacja łapania.');
  } catch (error) {
    await rollbackTransaction(env, accessToken, tx.transaction);
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin'
        }
      });
    }
    if (!origin) return json({ ok: false, error: 'Niedozwolone źródło żądania.' }, 403);
    if (request.method !== 'POST' ||
        !['/capture/start', '/capture/finish', '/capture/cancel'].includes(url.pathname)) {
      return json({ ok: false, error: 'Nie znaleziono endpointu.' }, 404, origin);
    }
    const authorization = request.headers.get('Authorization') || '';
    const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!idToken) return json({ ok: false, error: 'Brak tokenu Firebase.' }, 401, origin);

    try {
      const input = await request.json();
      const uid = await verifyFirebaseIdToken(idToken, env);
      const result = await handleAction(env, url.pathname.split('/').pop(), uid, input || {});
      return json(result, 200, origin);
    } catch (error) {
      const status = Number(error && error.status) || 500;
      const message = error && error.message ? error.message : 'Wewnętrzny błąd backendu łapania.';
      if (status >= 500) console.error('Huntly capture worker:', message);
      return json({ ok: false, error: message }, status, origin);
    }
  }
};
