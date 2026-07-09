// preload.js — Fraktum Launcher safe bridge
// Exposes:
//   window.launcher / window.api — Electron IPC helpers
//   window.sb                  — Supabase auth/social/playtime helpers

const { contextBridge, ipcRenderer } = require('electron');

let createClientMaybe = null;
let supabase = null;

const SUPABASE_URL = 'https://bvnbqjhgnlvthkluddfj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2bmJxamhnbmx2dGhrbHVkZGZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxMjcwNjYsImV4cCI6MjA3MzcwMzA2Nn0.TB-qIFbtL_d5Gno99JdttsS2LdyC6z_9n0WN_Uj9QLY';

function getSupabaseProjectRef() {
  try {
    return new URL(SUPABASE_URL).hostname.split('.')[0] || '';
  } catch (_e) {
    return '';
  }
}

function normalizeHandoffSession(value) {
  if (!value || typeof value !== 'object') return null;
  const source = value.session && typeof value.session === 'object' ? value.session : value;
  if (!source.access_token || !source.refresh_token) return null;

  const expiresAt = Number(source.expires_at || 0) || Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: String(source.access_token),
    refresh_token: String(source.refresh_token),
    expires_at: expiresAt,
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    token_type: source.token_type || 'bearer',
    user: source.user || null,
  };
}

function readLauncherSessionFromLocation() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const encoded = params.get('fraktumSession');
    if (!encoded) return null;

    const json = Buffer.from(String(encoded), 'base64url').toString('utf8');
    return normalizeHandoffSession(JSON.parse(json));
  } catch (error) {
    console.warn('[FRAKTUM] Failed to read launcher auth handoff:', String(error?.message || error));
    return null;
  }
}

function persistLauncherSessionForGame(session) {
  const normalized = normalizeHandoffSession(session);
  if (!normalized) return false;

  try {
    const projectRef = getSupabaseProjectRef();
    const keys = [
      projectRef ? `sb-${projectRef}-auth-token` : '',
      'fraktum.launcher.auth-session',
    ].filter(Boolean);

    const payload = JSON.stringify(normalized);
    for (const key of keys) {
      window.localStorage?.setItem(key, payload);
    }

    window.sessionStorage?.setItem('fraktum.launcher.auth-session', payload);
    window.__FRAKTUM_LAUNCHER_AUTH__ = normalized;

    console.info('[FRAKTUM] Launcher auth handoff persisted for game');
    return true;
  } catch (error) {
    console.warn('[FRAKTUM] Failed to persist launcher auth handoff:', String(error?.message || error));
    return false;
  }
}

// This preload is also used for the downloaded card game window.
// Persist the launcher Supabase session before the game bundle starts.
persistLauncherSessionForGame(readLauncherSessionFromLocation());

try {
  ({ createClient: createClientMaybe } = require('@supabase/supabase-js'));
} catch (_e) {
  // Loaded lazily in ensureClient().
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Некорректный email');
  return value;
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanSearch(value) {
  return String(value || '')
    .trim()
    .replace(/[%,()]/g, '')
    .slice(0, 40);
}

function cleanUuid(value, field = 'id') {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Некорректный ${field}`);
  }
  return id;
}

function extractAuthCode(rawCode) {
  const value = String(rawCode || '').trim();
  if (!value) throw new Error('Нет кода');

  try {
    const url = new URL(value);
    return url.searchParams.get('code') || url.hash.match(/(?:^|[&#])access_token=([^&]+)/)?.[1] || value;
  } catch (_e) {
    return value;
  }
}


function normalizeSupabaseError(error) {
  const raw = String(error?.message || error || '');
  const code = String(error?.code || error?.status || '');
  const networkLike = /failed to fetch|fetch failed|networkerror|network error|load failed|err_connection_reset|err_http2_ping_failed|http2_ping_failed|ping_failed|err_internet_disconnected|err_name_not_resolved|econnreset|etimedout|timeout|aborterror|aborted a request|user aborted/i.test(raw + ' ' + code);

  if (networkLike) {
    const e = new Error('Нет соединения с Supabase. Это не ошибка SQL/RLS: соединение сбрасывается до ответа сервера. Проверь интернет, VPN/прокси, антивирус/фаервол и доступ к supabase.co.');
    e.code = 'SUPABASE_NETWORK_ERROR';
    e.cause = error;
    return e;
  }

  return error instanceof Error ? error : new Error(raw || 'Неизвестная ошибка Supabase');
}

function safeApi(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw normalizeSupabaseError(error);
    }
  };
}

const SUPABASE_REQUEST_TIMEOUT_MS = 45000;

async function timeoutFetch(url, options = {}) {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch (_) {}
  }, SUPABASE_REQUEST_TIMEOUT_MS);

  const externalSignal = options.signal;
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    externalSignal.addEventListener('abort', () => {
      try { controller.abort(); } catch (_) {}
    }, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const e = new Error('Supabase не ответил за 45 секунд. Запрос остановлен, чтобы лаунчер не завис. Проверь VPN/прокси, антивирус/фаервол и стабильность сети.');
      e.code = 'SUPABASE_TIMEOUT';
      e.cause = error;
      throw e;
    }
    throw normalizeSupabaseError(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureClient() {
  if (supabase) return supabase;

  if (!createClientMaybe) {
    try {
      const mod = await import('@supabase/supabase-js');
      createClientMaybe = mod.createClient;
    } catch (e) {
      throw new Error(`Supabase SDK не загружен: ${String(e?.message || e)}`);
    }
  }

  let storage;
  try { storage = globalThis.localStorage; } catch (_e) { storage = undefined; }

  supabase = createClientMaybe(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage,
    },
    global: {
      fetch: timeoutFetch,
    },
  });

  return supabase;
}

async function getSession() {
  const sb = await ensureClient();
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  return data.session || null;
}

async function getSessionUser() {
  const session = await getSession();
  return session?.user || null;
}

async function getUser() {
  const sb = await ensureClient();
  const { data, error } = await sb.auth.getUser();
  if (error) throw error;
  return data.user || null;
}

async function getUserId() {
  const user = await getSessionUser();
  return user?.id || null;
}

function onAuthStateChange(cb) {
  const safe = typeof cb === 'function' ? cb : () => {};
  let unsubscribe = () => {};

  ensureClient()
    .then((sb) => {
      const { data } = sb.auth.onAuthStateChange((event, session) => {
        safe({ event, user: session?.user || null, session: session || null });
      });
      unsubscribe = () => data?.subscription?.unsubscribe?.();
    })
    .catch((error) => safe({ event: 'ERROR', error: String(error?.message || error) }));

  return () => unsubscribe();
}

async function sendMagicLink(email) {
  const sb = await ensureClient();
  const cleanEmail = normalizeEmail(email);
  const { error } = await sb.auth.signInWithOtp({
    email: cleanEmail,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
  return true;
}

async function verifyOtp(email, rawCode) {
  const sb = await ensureClient();
  const code = extractAuthCode(rawCode);

  // 6-digit email OTP from Supabase template.
  if (/^\d{6}$/.test(code)) {
    const { error } = await sb.auth.verifyOtp({
      email: normalizeEmail(email),
      token: code,
      type: 'email',
    });
    if (error) throw error;
    await ensureProfile();
    return true;
  }

  // PKCE/magic-link code.
  if (typeof sb.auth.exchangeCodeForSession === 'function') {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) throw error;
    await ensureProfile();
    return true;
  }

  throw new Error('Неверный формат кода');
}

async function ensureProfile() {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) return null;

  // Do not block login on profile insert/update.
  // Correct production flow: auth.users trigger creates public.profiles.
  // Client upsert can fail with 403 when RLS is strict.
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    if (error) throw error;
    if (data?.id) return true;

    const fallbackName = user.email ? user.email.split('@')[0] : `Player-${String(user.id).slice(0, 6)}`;
    const insert = await sb.from('profiles').insert({
      id: user.id,
      email: user.email || null,
      display_name: fallbackName.slice(0, 32),
      updated_at: new Date().toISOString(),
    });

    if (insert.error) {
      console.warn('[profiles] insert skipped:', insert.error.message || insert.error);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[profiles] ensure skipped:', error?.message || error);
    return false;
  }
}

async function getProfile() {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) return null;

  const fallback = {
    id: user.id,
    email: user.email || null,
    username: null,
    display_name: user.email ? user.email.split('@')[0] : 'User',
    avatar_url: null,
    last_seen: null,
    created_at: null,
  };

  await ensureProfile();

  const { data, error } = await sb
    .from('profiles')
    .select('id, username, display_name, avatar_url, last_seen, created_at')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    console.warn('[profiles] read failed:', error.message || error);
    return fallback;
  }

  return {
    ...fallback,
    ...(data || {}),
    id: user.id,
    email: user.email || null,
  };
}

async function updateProfile(fields = {}) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const updates = { updated_at: new Date().toISOString() };

  if ('display_name' in fields) {
    const name = cleanText(fields.display_name, 32);
    if (name.length < 2) throw new Error('Имя должно быть от 2 символов');
    updates.display_name = name;
  }

  if ('username' in fields) {
    const username = String(fields.username || '').trim().toLowerCase();
    if (username && !/^[a-z0-9_]{3,24}$/.test(username)) {
      throw new Error('Ник: 3–24 символа, латиница, цифры и _');
    }
    updates.username = username || null;
  }

  if ('avatar_url' in fields) updates.avatar_url = fields.avatar_url || null;

  await ensureProfile();

  const { data, error } = await sb
    .from('profiles')
    .update(updates)
    .eq('id', user.id)
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) {
    throw new Error('Профиль ещё не создан в Supabase. Выполни SQL-патч profiles RLS/trigger из архива.');
  }
  return true;
}

async function toUploadBody(fileLike) {
  if (!fileLike) throw new Error('Файл не выбран');

  if (typeof fileLike.arrayBuffer === 'function') {
    const ab = await fileLike.arrayBuffer();
    if (ab.byteLength > 5 * 1024 * 1024) throw new Error('Аватар больше 5 МБ');
    return new Blob([ab], { type: fileLike.type || 'application/octet-stream' });
  }

  if (fileLike instanceof ArrayBuffer) {
    if (fileLike.byteLength > 5 * 1024 * 1024) throw new Error('Аватар больше 5 МБ');
    return new Blob([fileLike], { type: 'image/png' });
  }

  if (typeof fileLike === 'string' && fileLike.startsWith('data:')) {
    const comma = fileLike.indexOf(',');
    const meta = fileLike.slice(0, comma);
    const mime = meta.match(/^data:([^;]+)/)?.[1] || 'image/png';
    const bin = Buffer.from(fileLike.slice(comma + 1), 'base64');
    if (bin.byteLength > 5 * 1024 * 1024) throw new Error('Аватар больше 5 МБ');
    return new Blob([bin], { type: mime });
  }

  return fileLike;
}

async function uploadAvatar(fileLike) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const mime = fileLike?.type || 'image/png';
  if (!/^image\/(png|jpeg|jpg|webp)$/i.test(mime)) throw new Error('Нужна картинка PNG/JPG/WebP');

  const body = await toUploadBody(fileLike);
  const ext = mime.includes('webp') ? 'webp' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  const path = `${user.id}/avatar.${ext}`;
  const bucket = sb.storage.from('avatars');

  const { error } = await bucket.upload(path, body, {
    upsert: true,
    cacheControl: '3600',
    contentType: mime,
  });
  if (error) throw error;

  const { data } = bucket.getPublicUrl(path);
  const url = `${data.publicUrl}`;
  await updateProfile({ avatar_url: url });
  return { path, url };
}

async function signOut() {
  const sb = await ensureClient();
  const { error } = await sb.auth.signOut();
  if (error) throw error;
  return true;
}

async function searchUsersByNick(nick) {
  const sb = await ensureClient();
  const me = await getSessionUser();
  if (!me) throw new Error('Требуется вход');

  const q = cleanSearch(nick);
  if (q.length < 2) return [];

  const { data, error } = await sb
    .from('profiles')
    .select('id, username, display_name, avatar_url, last_seen')
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .limit(20);

  if (error) throw error;
  return (data || []).filter((p) => p.id !== me.id);
}

async function sendFriendRequest(toUserId) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const target = cleanUuid(toUserId, 'получатель');
  if (target === user.id) throw new Error('Нельзя отправить заявку самому себе');

  const existingFriend = await sb
    .from('friends')
    .select('friend_id')
    .eq('user_id', user.id)
    .eq('friend_id', target)
    .maybeSingle();
  if (existingFriend.error) throw existingFriend.error;
  if (existingFriend.data) return { ok: true, alreadyFriends: true };

  const pending = await sb
    .from('friend_requests')
    .select('id, status, from_id, to_id')
    .or(`and(from_id.eq.${user.id},to_id.eq.${target},status.eq.pending),and(from_id.eq.${target},to_id.eq.${user.id},status.eq.pending)`)
    .limit(1);
  if (pending.error) throw pending.error;
  if (pending.data?.length) return { ok: true, duplicate: true, status: pending.data[0].status };

  const { error } = await sb
    .from('friend_requests')
    .insert({ from_id: user.id, to_id: target, status: 'pending' });

  if (error) {
    if (String(error.code) === '23505' || String(error.status) === '409') return { ok: true, duplicate: true };
    throw error;
  }

  return { ok: true };
}

async function listIncomingRequests() {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const { data, error } = await sb
    .from('friend_requests')
    .select('id, from_id, status, created_at, from:from_id(id, username, display_name, avatar_url)')
    .eq('to_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function listOutgoingRequests() {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const { data, error } = await sb
    .from('friend_requests')
    .select('id, to_id, status, created_at, to:to_id(id, username, display_name, avatar_url)')
    .eq('from_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function respondFriendRequest(requestId, accept) {
  const sb = await ensureClient();
  const id = cleanUuid(requestId, 'заявка');

  if (accept) {
    const rpc = await sb.rpc('accept_friend_request', { request_id: id });
    if (!rpc.error) return { ok: true, accepted: true };

    // Fallback for old DB without RPC. Works only if RLS allows it.
    const user = await getSessionUser();
    if (!user) throw new Error('Требуется вход');
    const { data, error } = await sb
      .from('friend_requests')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', id)
      .eq('to_id', user.id)
      .eq('status', 'pending')
      .select('from_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false };

    const other = data.from_id;
    const { error: e2 } = await sb.from('friends').upsert(
      [
        { user_id: user.id, friend_id: other },
        { user_id: other, friend_id: user.id },
      ],
      { onConflict: 'user_id,friend_id' }
    );
    if (e2) throw e2;
    return { ok: true, accepted: true };
  }

  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');
  const { error } = await sb
    .from('friend_requests')
    .update({ status: 'rejected', responded_at: new Date().toISOString() })
    .eq('id', id)
    .eq('to_id', user.id)
    .eq('status', 'pending');
  if (error) throw error;
  return { ok: true, accepted: false };
}

async function listFriends() {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const { data, error } = await sb
    .from('friends')
    .select('friend_id, profiles:friend_id(id, username, display_name, avatar_url, last_seen)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const now = Date.now();
  return (data || []).map((row) => {
    const p = row.profiles || {};
    return {
      id: p.id || row.friend_id,
      username: p.username || null,
      display_name: p.display_name || 'Игрок',
      avatar_url: p.avatar_url || null,
      online: Boolean(p.last_seen && now - new Date(p.last_seen).getTime() < 120000),
    };
  });
}

async function removeFriend(friendId) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');
  const other = cleanUuid(friendId, 'друг');

  const { error } = await sb
    .from('friends')
    .delete()
    .or(`and(user_id.eq.${user.id},friend_id.eq.${other}),and(user_id.eq.${other},friend_id.eq.${user.id})`);

  if (error) throw error;
  return true;
}

async function getProfileById(id) {
  const sb = await ensureClient();
  const userId = cleanUuid(id, 'профиль');
  const { data, error } = await sb
    .from('profiles')
    .select('id, username, display_name, avatar_url, last_seen, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function fetchProfilesMap(ids) {
  const sb = await ensureClient();
  const uniq = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniq.length) return new Map();

  const { data, error } = await sb
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', uniq);

  if (error) return new Map();
  return new Map((data || []).map((p) => [p.id, p]));
}

async function getComments(targetUserId) {
  const sb = await ensureClient();
  const target = cleanUuid(targetUserId, 'профиль');

  const { data, error } = await sb
    .from('comments')
    .select('id, author_id, text, created_at')
    .eq('target_id', target)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  const pmap = await fetchProfilesMap((data || []).map((c) => c.author_id));
  return (data || []).map((c) => {
    const p = pmap.get(c.author_id) || {};
    return {
      id: c.id,
      author_id: c.author_id,
      author_name: p.display_name || 'Игрок',
      author_username: p.username || null,
      author_avatar: p.avatar_url || null,
      text: c.text,
      ts: c.created_at ? new Date(c.created_at).getTime() : Date.now(),
    };
  });
}

async function addComment(targetUserId, text) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const target = cleanUuid(targetUserId, 'профиль');
  const body = cleanText(text, 500);
  if (!body) throw new Error('Пустой комментарий');

  const { error } = await sb.from('comments').insert({ author_id: user.id, target_id: target, text: body });
  if (error) throw error;
  return true;
}

async function heartbeat() {
  try {
    const sb = await ensureClient();
    const user = await getSessionUser();
    if (!user) return false;
    await sb.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', user.id);
    return true;
  } catch (_e) {
    return false;
  }
}

setInterval(heartbeat, 30000);

async function startPlaySession(gameId) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');
  const gid = cleanText(gameId, 64);
  if (!gid) throw new Error('Нет gameId');

  await sb
    .from('playtime_sessions')
    .update({ stopped_at: new Date().toISOString() })
    .is('stopped_at', null)
    .eq('user_id', user.id)
    .eq('game_id', gid);

  const { data, error } = await sb
    .from('playtime_sessions')
    .insert({ user_id: user.id, game_id: gid })
    .select('id')
    .maybeSingle();

  if (error) throw error;
  return { ok: true, id: data?.id || null };
}

async function stopPlaySession(gameId) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');
  const gid = cleanText(gameId, 64);
  if (!gid) throw new Error('Нет gameId');

  const { error } = await sb
    .from('playtime_sessions')
    .update({ stopped_at: new Date().toISOString() })
    .is('stopped_at', null)
    .eq('user_id', user.id)
    .eq('game_id', gid);
  if (error) throw error;
  return true;
}

async function getPlaytime(gameId) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');
  const gid = cleanText(gameId, 64);
  if (!gid) throw new Error('Нет gameId');

  const { data, error } = await sb
    .from('playtime_sessions')
    .select('started_at, stopped_at')
    .eq('user_id', user.id)
    .eq('game_id', gid);
  if (error) throw error;

  return (data || []).reduce((seconds, s) => {
    const a = new Date(s.started_at).getTime();
    const b = s.stopped_at ? new Date(s.stopped_at).getTime() : Date.now();
    return seconds + (!Number.isNaN(a) && !Number.isNaN(b) && b > a ? Math.floor((b - a) / 1000) : 0);
  }, 0);
}

async function getRecentPlaytimes(limit = 10) {
  const sb = await ensureClient();
  const user = await getSessionUser();
  if (!user) throw new Error('Требуется вход');

  const { data, error } = await sb
    .from('playtime_sessions')
    .select('game_id, started_at, stopped_at')
    .eq('user_id', user.id)
    .limit(1000);
  if (error) throw error;

  const map = new Map();
  (data || []).forEach((s) => {
    const a = new Date(s.started_at).getTime();
    const b = s.stopped_at ? new Date(s.stopped_at).getTime() : Date.now();
    const d = !Number.isNaN(a) && !Number.isNaN(b) && b > a ? Math.floor((b - a) / 1000) : 0;
    map.set(s.game_id, (map.get(s.game_id) || 0) + d);
  });

  return Array.from(map.entries())
    .map(([game_id, seconds]) => ({ game_id, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, Number(limit) || 10);
}

async function health() {
  try {
    await timeoutFetch(`${SUPABASE_URL}/auth/v1/health`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeSupabaseError(error).message };
  }
}

async function getNovelSignedUrl(path) {
  const sb = await ensureClient();
  const filePath = String(path || '').trim();
  if (!filePath || filePath.includes('..')) throw new Error('Некорректный путь файла');

  const { data, error } = await sb.storage.from('builds').createSignedUrl(filePath, 60);
  if (error) throw error;
  return data.signedUrl;
}

const launcherApi = Object.freeze({
  selectExe: () => ipcRenderer.invoke('select-exe'),
  getExe: () => ipcRenderer.invoke('get-exe'),
  runGame: (payload) => ipcRenderer.invoke('run-game', payload),
  getAuthSession: getSession,
  getLauncherHandoffSession: () => Promise.resolve(normalizeHandoffSession(window.__FRAKTUM_LAUNCHER_AUTH__ || null)),
  getCardGameStatus: (payload) => ipcRenderer.invoke('card-game:status', payload),
  installCardGame: (payload) => ipcRenderer.invoke('card-game:install', payload),
  openCardGame: (payload) => ipcRenderer.invoke('card-game:open', payload),
  saveUpload: (payload) => ipcRenderer.invoke('save-upload', payload),
  saveDownload: (payload) => ipcRenderer.invoke('save-download', payload),
  downloadNovel: (payload) => ipcRenderer.invoke('download-novel', payload),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  getLauncherConfig: () => ipcRenderer.invoke('launcher-config'),
  getLauncherConfigPath: () => ipcRenderer.invoke('launcher-config-path'),
  getUserDataPath: () => ipcRenderer.invoke('user-data-path'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('update:quitAndInstall'),
  onUpdateStatus: (cb) => {
    const listener = (_event, payload) => typeof cb === 'function' && cb(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  onUpdateProgress: (cb) => {
    const listener = (_event, payload) => typeof cb === 'function' && cb(payload);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onGameStatus: (cb) => {
    const listener = (_event, payload) => typeof cb === 'function' && cb(payload);
    ipcRenderer.on('game:status', listener);
    return () => ipcRenderer.removeListener('game:status', listener);
  },
  onGameProgress: (cb) => {
    const listener = (_event, payload) => typeof cb === 'function' && cb(payload);
    ipcRenderer.on('game:progress', listener);
    return () => ipcRenderer.removeListener('game:progress', listener);
  },
});

const sbApiRaw = {
  __version: 'preload-2026-07-08-game-auth-handoff',
  __list: () => Object.keys(sbApi).sort(),

  getSession,
  getUserId,
  onAuthStateChange,
  sendMagicLink,
  verifyOtp,
  getProfile,
  updateProfile,
  uploadAvatar,
  signOut,

  searchUsersByNick,
  sendFriendRequest,
  listIncomingRequests,
  listOutgoingRequests,
  respondFriendRequest,
  listFriends,
  removeFriend,
  getProfileById,
  getComments,
  addComment,

  heartbeat,
  health,
  startPlaySession,
  stopPlaySession,
  getPlaytime,
  getRecentPlaytimes,

  getNovelSignedUrl,
};

const sbApi = Object.freeze(Object.fromEntries(
  Object.entries(sbApiRaw).map(([key, value]) => [
    key,
    typeof value === 'function' && !key.startsWith('__') && key !== 'onAuthStateChange' ? safeApi(value) : value,
  ])
));

contextBridge.exposeInMainWorld('launcher', launcherApi);
contextBridge.exposeInMainWorld('api', launcherApi);
contextBridge.exposeInMainWorld('sb', sbApi);
