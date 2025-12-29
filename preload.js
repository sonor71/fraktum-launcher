// preload.js
// Безопасный мост Supabase → рендер. Доступно как window.sb.{...}
const { contextBridge } = require('electron');

// === ДОБАВЛЕНО: разрешаем полностью тихий офлайн-режим, когда SDK не установлена ===
const SUPABASE_OPTIONAL = true;

// --- ВАЖНО: не падаем, если supabase-js недоступен или это ESM --- //
let createClientMaybe = null;     // сюда положим createClient
let supabase = null;              // глобальный клиент после инициализации

// Пытаемся синхронно через require (если модуль есть и CommonJS-совместим)
try {
  ({ createClient: createClientMaybe } = require('@supabase/supabase-js'));
} catch (_) {
  // ок, попробуем позже через динамический import()
}

/** Гарантирует, что supabase создан.
 * Если модуль не установлен — В ТИШИНЕ выходим (офлайн), прелоад не падает.
 */
async function ensureClient() {
  if (supabase) return supabase;

  // если не удалось require — пробуем ESM import
  if (!createClientMaybe) {
    try {
      const mod = await import('@supabase/supabase-js');
      createClientMaybe = mod.createClient;
    } catch (e) {
      if (SUPABASE_OPTIONAL) return null;
      throw new Error(
        "Supabase SDK недоступен. Установи @supabase/supabase-js в dependencies сборки.\n" +
        String(e?.message || e)
      );
    }
  }

  // ======================== CONFIG ========================
  const SUPABASE_URL = 'https://bvnbqjhgnlvthkluddfj.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2bmJxamhnbmx2dGhrbHVkZGZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxMjcwNjYsImV4cCI6MjA3MzcwMzA2Nn0.TB-qIFbtL_d5Gno99JdttsS2LdyC6z_9n0WN_Uj9QLY';

  // ==================== Supabase client ===================
  let storage;
  try { storage = globalThis.localStorage; } catch { storage = undefined; }

  if (!createClientMaybe) return null; // на всякий случай — тоже тихо

  supabase = createClientMaybe(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage,
    },
  });

  return supabase;
}

/* =================== AUTH / PROFILE ===================== */
async function getSession() {
  await ensureClient();
  if (!supabase) return null; // офлайн-заглушка
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}
async function getUser() {
  await ensureClient();
  if (!supabase) return null; // офлайн
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user ?? null;
}
// ADD: быстрый хелпер — только id
async function getUserId() {
  const u = await getUser();
  return u?.id || null;
}
// ADD: подписка на смену сессии (для нескольких окон/акков)
function onAuthStateChange(cb) {
  const safe = typeof cb === 'function' ? cb : () => {};
  (async () => {
    await ensureClient();
    if (!supabase) return () => {};
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      try { safe({ event: _event, user: session?.user || null }); } catch {}
    });
    return sub?.subscription?.unsubscribe ?? (() => {});
  })();
  // возвращаем no-op, т.к. колбэк уходит «внутрь»
  return () => {};
}

async function sendMagicLink(email) {
  await ensureClient();
  if (!supabase) return false; // офлайн: просто false, без ошибок
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
  return true;
}
async function verifyOtp(email, rawCode) {
  await ensureClient();
  if (!supabase) return false; // офлайн
  const code = String(rawCode || '').trim();
  if (!code) throw new Error('Нет кода');

  if (code.length > 8 && typeof supabase.auth.exchangeCodeForSession === 'function') {
    const { error } = await supabase.auth.exchangeCodeForSession({ authCode: code });
    if (error) throw error;
    return true;
  }
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) throw error;
  return true;
}

async function ensureProfile() {
  await ensureClient();
  if (!supabase) return null; // офлайн
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('id').eq('id', user.id).limit(1);
  if (error) throw error;
  if (data && data[0]) return true;
  await supabase.from('profiles').insert({ id: user.id, email: user.email }).catch(() => {});
  return true;
}

async function getProfile() {
  await ensureClient();
  if (!supabase) return { display_name: null, avatar_url: null, email: null }; // офлайн
  await ensureProfile();
  const user = await getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, avatar_url, email')
    .eq('id', user.id)
    .limit(1);
  if (error) throw error;
  const row = Array.isArray(data) && data[0] ? data[0] : null;
  return row || { display_name: null, avatar_url: null, email: user.email };
}

async function updateProfile(fields = {}) {
  await ensureClient();
  if (!supabase) return false; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const updates = { id: user.id };
  if ('display_name' in fields) updates.display_name = fields.display_name ?? null;
  if ('avatar_url'   in fields) updates.avatar_url   = fields.avatar_url ?? null;
  if ('email'        in fields) updates.email        = fields.email ?? null;

  const { error } = await supabase.from('profiles').upsert(updates, { onConflict: 'id' });
  if (error) throw error;
  return true;
}

/* ======================= AVATAR ========================= */
async function toUploadBody(fileLike) {
  if (!fileLike) throw new Error('Файл не выбран');
  if (typeof fileLike.arrayBuffer === 'function') {
    const ab = await fileLike.arrayBuffer();
    return new Blob([ab], { type: fileLike.type || 'application/octet-stream' });
  }
  if (fileLike instanceof ArrayBuffer) return new Blob([fileLike], { type: 'application/octet-stream' });
  if (fileLike?.buffer && fileLike.byteLength != null) return new Blob([fileLike], { type: 'application/octet-stream' });
  if (typeof fileLike === 'string' && fileLike.startsWith('data:')) {
    const comma = fileLike.indexOf(',');
    const b64 = fileLike.slice(comma + 1);
    const bin = Buffer.from(b64, 'base64');
    return new Blob([bin], { type: 'application/octet-stream' });
  }
  return fileLike;
}

async function uploadAvatar(fileLike) {
  await ensureClient();
  if (!supabase) return { path: null, url: '' }; // офлайн — молчим, возвращаем пусто
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');

  const body = await toUploadBody(fileLike);
  let ext = 'png';
  try {
    if (fileLike?.name) ext = (fileLike.name.split('.').pop() || 'png').toLowerCase();
    else if (fileLike?.type && fileLike.type.includes('/')) ext = fileLike.type.split('/').pop();
  } catch {}

  const path = `${user.id}/avatar.${ext}`;
  const bucket = supabase.storage.from('avatars');
  const { error } = await bucket.upload(path, body, {
    upsert: true,
    cacheControl: '3600',
    contentType: fileLike?.type || 'image/png',
  });
  if (error) throw error;

  const { data } = bucket.getPublicUrl(path);
  return { path, url: `${data.publicUrl}?v=${Date.now()}` };
}

async function signOut() {
  await ensureClient();
  if (!supabase) return true; // офлайн — noop
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  return true;
}

/* ========== FRIENDS / SEARCH / REQUESTS / COMMENTS ========== */
async function searchUsersByNick(nick) {
  await ensureClient();
  if (!supabase) return []; // офлайн
  const me = await getUser();
  if (!me) throw new Error('Требуется вход');
  const q = String(nick || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_url, email')
    .or(`display_name.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(20);
  if (error) throw error;
  return (data || []).filter(p => p.id !== me.id);
}

/** UPDATED: мягко обрабатывает 409/дубликаты */
async function sendFriendRequest(toUserId) {
  await ensureClient();
  if (!supabase) return { ok:false, offline:true }; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');

  const target = String(toUserId || '').trim();
  if (!target) throw new Error('Некорректный получатель');
  if (target === user.id) throw new Error('Нельзя отправить заявку самому себе');

  const check = await supabase
    .from('friend_requests')
    .select('id,status,from_id,to_id')
    .or(`and(from_id.eq.${user.id},to_id.eq.${target}),and(from_id.eq.${target},to_id.eq.${user.id})`)
    .limit(1);
  if (check.error) throw check.error;
  if (check.data && check.data.length) {
    return { ok: true, duplicate: true, status: check.data[0].status };
  }

  const { error } = await supabase
    .from('friend_requests')
    .insert({ from_id: user.id, to_id: target, status: 'pending' });

  if (error) {
    if (String(error.code) === '23505' || String(error.status) === '409') {
      return { ok: true, duplicate: true };
    }
    if (String(error.status) === '409') {
      return { ok: false, reason: 'conflict', details: error.message || 'Conflict' };
    }
    throw error;
  }
  return { ok: true };
}

async function listIncomingRequests() {
  await ensureClient();
  if (!supabase) return []; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const { data, error } = await supabase
    .from('friend_requests')
    .select('id, from_id, status, created_at, from:from_id (id, display_name, avatar_url)')
    .eq('to_id', user.id)
    .order('created_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function listOutgoingRequests() {
  await ensureClient();
  if (!supabase) return []; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const { data, error } = await supabase
    .from('friend_requests')
    .select('id, to_id, status, created_at, to:to_id (id, display_name, avatar_url)')
    .eq('from_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function respondFriendRequest(requestId, accept) {
  await ensureClient();
  if (!supabase) return { ok:false, offline:true }; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  if (!requestId) throw new Error('Нет id заявки');

  if (accept) {
    const { data, error } = await supabase
      .from('friend_requests')
      .update({ status: 'accepted' })
      .eq('id', requestId)
      .eq('to_id', user.id)
      .select('from_id')
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) && data[0];
    if (!row) return { ok: false };

    const other = row.from_id;
    const { error: e2 } = await supabase
      .from('friends')
      .upsert(
        [
          { user_id: user.id, friend_id: other },
          { user_id: other,   friend_id: user.id },
        ],
        { onConflict: 'user_id,friend_id' }
      );
    if (e2) throw e2;
    return { ok: true, accepted: true };
  } else {
    const { error } = await supabase
      .from('friend_requests')
      .update({ status: 'rejected' })
      .eq('id', requestId)
      .eq('to_id', user.id);
    if (error) throw error;
    return { ok: true, accepted: false };
  }
}

async function listFriends() {
  await ensureClient();
  if (!supabase) return []; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const { data, error } = await supabase
    .from('friends')
    .select('friend_id, profiles:friend_id (id, display_name, avatar_url, last_seen)')
    .eq('user_id', user.id);
  if (error) throw error;

  const now = Date.now();
  return (data || []).map(r => {
    const p = r.profiles || {};
    return {
      id: p.id || r.friend_id,
      display_name: p.display_name || 'Игрок',
      avatar_url: p.avatar_url || null,
      online: !!(p.last_seen && (now - new Date(p.last_seen).getTime()) < 120000),
    };
  });
}

async function removeFriend(friendId) {
  await ensureClient();
  if (!supabase) return true; // офлайн — считаем удалённым
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const { error } = await supabase
    .from('friends')
    .delete()
    .or(`and(user_id.eq.${user.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${user.id})`);
  if (error) throw error;
  return true;
}

async function getProfileById(id) {
  await ensureClient();
  if (!supabase) return null; // офлайн
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_url, last_seen, email')
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function getComments(targetUserId) {
  await ensureClient();
  if (!supabase) return []; // офлайн
  const { data, error } = await supabase
    .from('comments')
    .select('author_id, text, created_at, author:author_id(display_name, avatar_url)')
    .eq('target_id', targetUserId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []).map(c => ({
    author_name: c.author?.display_name || 'Гость',
    author_avatar: c.author?.avatar_url || null,
    text: c.text,
    ts: new Date(c.created_at).getTime(),
  }));
}

/* ===== ДОБАВЛЕНО: безопасный фоллбэк для комментариев (убирает 400/406) ===== */
async function __fetchProfilesMap(ids) {
  await ensureClient();
  if (!supabase || !ids?.length) return new Map();
  const uniq = Array.from(new Set(ids));
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_url')
    .in('id', uniq);
  if (error) return new Map();
  const map = new Map();
  (data || []).forEach(p => map.set(p.id, { display_name: p.display_name || 'Игрок', avatar_url: p.avatar_url || null }));
  return map;
}
const __getComments_original = typeof getComments === 'function' ? getComments : null;

async function getComments_safe(targetUserId) {
  await ensureClient();
  if (!supabase) return [];
  if (__getComments_original) {
    try { return await __getComments_original(targetUserId); }
    catch (_) { /* фоллбэк ниже */ }
  }
  try {
    const { data, error, status } = await supabase
      .from('comments')
      .select('author_id, text, created_at, target_id')
      .eq('target_id', targetUserId)
      .limit(50);
    if (error && String(status) !== '406') throw error;
    const rows = data || [];
    const pmap = await __fetchProfilesMap(rows.map(r => r.author_id).filter(Boolean));
    return rows.map(c => {
      const p = pmap.get(c.author_id) || {};
      return {
        author_name: p.display_name || 'Гость',
        author_avatar: p.avatar_url || null,
        text: c.text,
        ts: c.created_at ? new Date(c.created_at).getTime() : Date.now(),
      };
    });
  } catch (_) {
    return [];
  }
}

async function addComment(targetUserId, text) {
  await ensureClient();
  if (!supabase) return false; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const t = String(text || '').trim();
  if (!t) throw new Error('Пустой комментарий');
  const { error } = await supabase
    .from('comments')
    .insert({ author_id: user.id, target_id: targetUserId, text: t });
  if (error) throw error;
  return true;
}

/* =============== ONLINE HEARTBEAT (last_seen) =============== */
setInterval(async () => {
  try {
    await ensureClient();
    if (!supabase) return;
    const user = await getUser();
    if (!user) return;
    await supabase.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', user.id);
  } catch {}
}, 30000);

/* ======================= PLAYTIME ======================== */
async function startPlaySession(gameId) {
  await ensureClient();
  if (!supabase) return true; // офлайн — no-op
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const gid = String(gameId || '').trim();
  if (!gid) throw new Error('Нет gameId');

  await supabase
    .from('playtime_sessions')
    .update({ stopped_at: new Date().toISOString() })
    .is('stopped_at', null)
    .eq('user_id', user.id)
    .eq('game_id', gid)
    .catch(() => {});

  const { error } = await supabase.from('playtime_sessions').insert({ user_id: user.id, game_id: gid });
  if (error) throw error;
  return true;
}
async function stopPlaySession(gameId) {
  await ensureClient();
  if (!supabase) return true; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const gid = String(gameId || '').trim();
  if (!gid) throw new Error('Нет gameId');
  const { error } = await supabase
    .from('playtime_sessions')
    .update({ stopped_at: new Date().toISOString() })
    .is('stopped_at', null)
    .eq('user_id', user.id)
    .eq('game_id', gid);
  if (error) throw error;
  return true;
}
async function getPlaytime(gameId) {
  await ensureClient();
  if (!supabase) return 0; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const gid = String(gameId || '').trim();
  if (!gid) throw new Error('Нет gameId');
  const { data, error } = await supabase
    .from('playtime_sessions')
    .select('started_at, stopped_at')
    .eq('user_id', user.id)
    .eq('game_id', gid);
  if (error) throw error;
  let seconds = 0;
  (data || []).forEach(s => {
    const a = new Date(s.started_at).getTime();
    const b = s.stopped_at ? new Date(s.stopped_at).getTime() : Date.now();
    if (!isNaN(a) && !isNaN(b) && b > a) seconds += Math.floor((b - a) / 1000);
  });
  return seconds;
}
async function getRecentPlaytimes(limit = 10) {
  await ensureClient();
  if (!supabase) return []; // офлайн
  const user = await getUser();
  if (!user) throw new Error('Требуется вход');
  const { data, error } = await supabase
    .from('playtime_sessions')
    .select('game_id, started_at, stopped_at')
    .eq('user_id', user.id);
  if (error) throw error;
  const map = new Map();
  (data || []).forEach(s => {
    const a = new Date(s.started_at).getTime();
    const b = s.stopped_at ? new Date(s.stopped_at).getTime() : Date.now();
    const d = (!isNaN(a) && !isNaN(b) && b > a) ? Math.floor((b - a) / 1000) : 0;
    map.set(s.game_id, (map.get(s.game_id) || 0) + d);
  });
  return Array.from(map.entries())
    .map(([game_id, seconds]) => ({ game_id, seconds }))
    .sort((x, y) => y.seconds - x.seconds)
    .slice(0, limit);
}

const { contextBridge } = require('electron');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://<YOUR-REF>.supabase.co';
const supabaseKey = '<YOUR-ANON-KEY>';
const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: true } });

contextBridge.exposeInMainWorld('sb', {
  // кто залогинен
  getUserId: async () => (await sb.auth.getUser()).data.user?.id || null,

  // получить подписанную ссылку на файл новеллы (живет 60 сек)
  getNovelSignedUrl: async (path) => {
    const { data, error } = await sb
      .storage.from('builds')
      .createSignedUrl(path, 60); // 60 секунд
    if (error) throw error;
    return data.signedUrl;
  },

  // логин по маг. ссылке/коду — как у тебя уже сделано
  sendMagicLink: async (email) => sb.auth.signInWithOtp({ email }),
  verifyOtp: async (email, token) => sb.auth.verifyOtp({ email, token, type: 'email' }),
  signOut: async () => sb.auth.signOut(),
});


/* ===================== DEBUG HELPERS ===================== */
function __list() { try { return Object.keys(window.sb || {}).sort(); } catch { return []; } }

/* ======================== EXPOSE ========================= */
contextBridge.exposeInMainWorld('sb', Object.freeze({
  __version: 'preload-2025-10-17+silent-offline',
  __list,

  // auth / profile
  getSession,
  getUserId,              // ADD
  onAuthStateChange,      // ADD
  sendMagicLink,
  verifyOtp,
  getProfile,
  updateProfile,
  uploadAvatar,
  signOut,

  // friends / search / comments
  searchUsersByNick,
  sendFriendRequest,        // ← обновлено
  listIncomingRequests,
  listOutgoingRequests,
  respondFriendRequest,
  listFriends,
  removeFriend,
  getProfileById,
  getComments: getComments_safe, // ← экспортим безопасную версию
  addComment,

  // playtime
  startPlaySession,
  stopPlaySession,
  getPlaytime,
  getRecentPlaytimes,
}));
