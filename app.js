/* SHeard · 唱片書籤 v2
 * 資料：本機 localStorage 為主，登入後與 Supabase 雙向同步（新的修改勝出）
 * 資料來源：全部取自 Spotify（搜尋、歌手作品、曲目、最近播放），一律手動標記
 */
const CFG = window.HEARD_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

/* ================= 資料層 ================= */
const KEY = 'heard.v2';
const norm = s => (s || '').toLowerCase()
  .replace(/\s*[\(\[](deluxe|remaster|explicit|clean|expanded|anniversary|bonus|special)[^\)\]]*[\)\]]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '').trim();
// 用「歌手名＋專輯名」當作唯一鍵，讓 Spotify、手動新增、以及舊版資料的同一張專輯對得起來
const albumKey = a => `${norm(a.artist)}|${norm(a.title)}`;

const db = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.albums) return Object.assign({ deleted: {}, dirty: {} }, d); } catch (e) {}
  const d = { albums: {}, deleted: {}, dirty: {}, settings: {} };
  // 從 v1 搬資料過來
  try {
    const old = JSON.parse(localStorage.getItem('heard.v1'));
    if (old?.albums) {
      Object.values(old.albums).forEach(a => {
        const k = albumKey(a);
        d.albums[k] = { ...a, status: 'heard', addedAt: a.heardAt || Date.now(), updatedAt: Date.now() };
        d.dirty[k] = 1;
      });
      if (old.settings) Object.assign(d.settings, old.settings);
    }
  } catch (e) {}
  return d;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('儲存失敗'); } }
const statusOf = k => db.albums[k]?.status || null;

function fromSpotify(al) {
  const t = al.album_type;
  return {
    id: 'sp:' + al.id, spotifyId: al.id, title: al.name,
    artist: (al.artists || []).map(a => a.name).join(' & '), artistId: al.artists?.[0]?.id || '',
    date: al.release_date || '',
    type: t === 'single' ? ((al.total_tracks || 0) >= 4 ? 'EP' : 'Single') : t === 'compilation' ? 'Compilation' : 'Album',
    year: (al.release_date || '').slice(0, 4), tracks: al.total_tracks || 0,
    cover: al.images?.[0]?.url || ''
  };
}

/* 設定狀態：'heard' | 'want' | null(移除) */
function setStatus(k, status) {
  const cur = db.albums[k];
  const now = Date.now();
  if (!status) {
    if (!cur) return;
    seen.set(k, cur); delete db.albums[k]; db.deleted[k] = now;
  } else if (cur) {
    cur.status = status; cur.updatedAt = now;
    if (status === 'heard') cur.heardAt = now;
  } else {
    const a = findAlbum(k); if (!a) return;
    const { _tracks, ...clean } = a;
    db.albums[k] = { ...clean, status, addedAt: now, updatedAt: now, heardAt: status === 'heard' ? now : null };
    delete db.deleted[k];
  }
  db.dirty[k] = 1; save(); scheduleSync();
  return true;
}
/* 防呆確認視窗，回傳 true / false */
function ask({ title, msg = '', ok = '確定', cancel = '保留' }) {
  return new Promise(done => {
    const el = document.createElement('div');
    el.className = 'dialog';
    el.innerHTML = `<div class="dialog-box" role="alertdialog" aria-modal="true">
      <h3>${esc(title)}</h3>${msg ? `<p>${msg}</p>` : ''}
      <div class="dialog-btns"><button class="btn" data-r="0">${esc(cancel)}</button><button class="btn danger" data-r="1">${esc(ok)}</button></div></div>`;
    const close = r => { el.classList.remove('show'); setTimeout(() => el.remove(), 180); done(r); };
    el.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-r]');
      if (b) close(b.dataset.r === '1'); else if (e.target === el) close(false);
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
  });
}
const statusName = s => ({ heard: '已聽過', want: '想聽', archived: '封存' })[s] || s;
// 「完成」：已聽過或封存，進度條都算進去
const isDone = s => s === 'heard' || s === 'archived';
async function toggle(k, status) {
  const was = statusOf(k);
  const a = db.albums[k];
  // 取消標記，或把「已聽過」改成其他狀態時，先確認
  if (a && (was === status || was === 'heard')) {
    const removing = was === status;
    const extra = removing && a.manual ? '<br><b>這是手動新增的唱片，取消後整筆資料會刪除。</b>' : '';
    const ok = await ask({
      title: removing ? `取消「${statusName(was)}」？` : `從「已聽過」改成「${statusName(status)}」？`,
      msg: `<b>${esc(a.title)}</b><br><span class="muted">${esc(a.artist)}</span>${extra}`,
      ok: removing ? `取消${statusName(was)}` : `改成${statusName(status)}`
    });
    if (!ok) return;
  }
  if (setStatus(k, was === status ? null : status) === false) return;
  toast(was === status ? ({ heard: '已取消「已聽過」', want: '已移出想聽', archived: '已取消封存' })[status]
    : ({ heard: '✓ 已聽過', want: '已加入想聽', archived: '已封存' })[status]);
  if (state.current) renderSheet();
  render();
}
function touch(k) { db.albums[k].updatedAt = Date.now(); db.dirty[k] = 1; save(); scheduleSync(); }

/* ================= Spotify 目錄（搜尋／歌手作品／曲目） ================= */
const cache = new Map();
async function spCached(path) {
  if (cache.has(path)) return cache.get(path);
  const j = await sp(path); cache.set(path, j); return j;
}
const isSpId = id => /^[0-9A-Za-z]{22}$/.test(id || '');
const dedupe = list => { const m = new Map(); list.forEach(a => { const k = albumKey(a); if (!m.has(k)) m.set(k, a); }); return [...m.values()]; };
// 開發模式每次最多 10 筆，一次抓 3 頁（30 筆）
async function searchAlbums(q) {
  const enc = encodeURIComponent(q);
  const pages = await Promise.all([0, 10, 20].map(o => spCached(`/search?type=album&limit=10&offset=${o}&market=from_token&q=${enc}`).catch(() => null)));
  if (pages.every(p => !p)) throw new Error('搜尋失敗');
  return dedupe(pages.flatMap(p => p?.albums?.items || []).filter(Boolean).map(fromSpotify));
}
async function searchArtists(q) {
  const enc = encodeURIComponent(q);
  const pages = await Promise.all([0, 10].map(o => spCached(`/search?type=artist&limit=10&offset=${o}&q=${enc}`).catch(() => null)));
  if (pages.every(p => !p)) throw new Error('搜尋失敗');
  const m = new Map(); pages.flatMap(p => p?.artists?.items || []).filter(Boolean).forEach(x => m.set(x.id, x));
  return [...m.values()];
}
async function searchArtistsTop(q) {
  const j = await spCached(`/search?type=artist&limit=10&q=${encodeURIComponent(q)}`);
  const list = (j?.artists?.items || []).filter(Boolean);
  const nq = norm(q);
  return list.filter(x => norm(x.name).includes(nq) || nq.includes(norm(x.name))).sort((a, b) => (norm(b.name) === nq) - (norm(a.name) === nq));
}
async function artistAlbums(id, groups = 'album,single,compilation') {
  let lim = 50, out = [];
  for (let off = 0; off < 300; off += lim) {
    let j;
    try { j = await spCached(`/artists/${id}/albums?include_groups=${groups}&market=from_token&limit=${lim}&offset=${off}`); }
    catch (e) { if (lim === 50 && off === 0 && /400/.test(e.message)) { lim = 10; off = -lim; continue; } throw e; }
    out.push(...(j?.items || []).filter(Boolean));
    if (!j?.next) break;
  }
  return dedupe(out.map(fromSpotify)).sort((a, b) => (b.date || b.year || '').localeCompare(a.date || a.year || ''));
}
async function resolveArtistId(name) {
  const j = await spCached(`/search?type=artist&limit=10&q=${encodeURIComponent(name)}`);
  const r = j?.artists?.items || [];
  const hit = r.find(x => norm(x.name) === norm(name)) || r.find(x => norm(name).startsWith(norm(x.name)));
  return hit?.id || '';
}
// 舊資料（沒有 Spotify id）→ 找出對應的 Spotify 專輯
async function resolveAlbum(a) {
  const q = encodeURIComponent(`album:${a.title} artist:${a.artist.split(' & ')[0]}`);
  const j = await spCached(`/search?type=album&limit=10&market=from_token&q=${q}`);
  const k = albumKey(a);
  const hit = (j?.albums?.items || []).filter(Boolean).map(fromSpotify).find(x => albumKey(x) === k);
  return hit || null;
}
async function albumTracks(spotifyId) {
  const j = await spCached('/albums/' + spotifyId);
  const items = [...(j?.tracks?.items || [])];
  let next = j?.tracks?.next;
  while (next && items.length < 300) {
    const p = await spCached(next.replace('https://api.spotify.com/v1', ''));
    items.push(...(p?.items || [])); next = p?.next;
  }
  return items.map(x => ({ n: x.track_number, name: x.name, ms: x.duration_ms }));
}

/* ================= Spotify（PKCE，免後端） ================= */
const SP_KEY = 'heard.spotify';
const SP_SCOPES = 'user-read-currently-playing user-read-recently-played';
let spTok = (() => { try { return JSON.parse(localStorage.getItem(SP_KEY)); } catch (e) { return null; } })();
const spOn = () => !!(CFG.SPOTIFY_CLIENT_ID && spTok?.refresh);
const spRedirect = () => location.origin + location.pathname.replace(/index\.html$/, '');
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function spotifyLogin() {
  if (location.hostname === 'localhost') { // Spotify 不接受 localhost，要用 127.0.0.1
    location.href = location.href.replace('//localhost', '//127.0.0.1'); return;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(12)));
  localStorage.setItem('heard.pkce', JSON.stringify({ verifier, st }));
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: CFG.SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: spRedirect(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SP_SCOPES, state: st
  });
}
async function spTokenReq(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.SPOTIFY_CLIENT_ID, ...body })
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || res.status);
  spTok = { access: j.access_token, refresh: j.refresh_token || spTok?.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
  localStorage.setItem(SP_KEY, JSON.stringify(spTok));
}
async function spotifyCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', spRedirect());
  if (p.get('error')) return toast('Spotify 連結已取消');
  const saved = JSON.parse(localStorage.getItem('heard.pkce') || '{}');
  localStorage.removeItem('heard.pkce');
  if (saved.st !== p.get('state')) return toast('Spotify 驗證失敗，請再試一次');
  try { await spTokenReq({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: spRedirect(), code_verifier: saved.verifier }); toast('✓ 已連結 Spotify'); }
  catch (e) { toast('Spotify 連結失敗：' + e.message); }
}
function spotifyLogout() { spTok = null; localStorage.removeItem(SP_KEY); state.sp = {}; }
async function sp(path, retry = true) {
  if (!spTok) throw new Error('not connected');
  if (!spTok.access || Date.now() > spTok.exp) {
    try { await spTokenReq({ grant_type: 'refresh_token', refresh_token: spTok.refresh }); }
    catch (e) { spotifyLogout(); render(); throw new Error('Spotify 登入已過期，請重新連結'); }
  }
  const res = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + spTok.access } });
  if (res.status === 204) return null;
  if (res.status === 401 && retry) { spTok.exp = 0; return sp(path, false); }
  if (res.status === 403) throw new Error('Spotify 拒絕存取：請確認你的帳號已加入開發者後台的 User Management，且 App 擁有者有 Premium');
  if (res.status === 429) throw new Error('Spotify 請求太頻繁，稍後再試');
  if (!res.ok) throw new Error('Spotify 錯誤 ' + res.status);
  return res.json();
}
async function spNowPlaying() {
  const j = await sp('/me/player/currently-playing');
  if (!j?.item?.album) return null;
  return { album: remember([fromSpotify(j.item.album)])[0], track: j.item.name, playing: j.is_playing };
}
async function spRecent() {
  const j = await sp('/me/player/recently-played?limit=50');
  const m = new Map();
  (j?.items || []).forEach(it => { const a = fromSpotify(it.track.album); const k = albumKey(a); if (!m.has(k)) m.set(k, a); });
  return remember([...m.values()]);
}

/* ================= 雲端同步（Supabase） ================= */
let sb = null, sbUser = null, syncing = false, syncT = null;
const syncOn = () => !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
async function initSync() {
  if (!syncOn()) return;
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js');
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, storageKey: 'heard.sb' } });
    const { data } = await sb.auth.getSession();
    sbUser = data.session?.user || null;
    sb.auth.onAuthStateChange((_e, s) => { sbUser = s?.user || null; });
    render();
    if (sbUser) syncNow();
  } catch (e) { console.warn('sync init failed', e); }
}
function scheduleSync() { if (!sbUser) return; clearTimeout(syncT); syncT = setTimeout(syncNow, 1500); }
async function syncNow(manual) {
  if (!sb || !sbUser || syncing) return;
  syncing = true; state.syncErr = ''; updateDot();
  try {
    // 1. 拉下雲端全部資料，時間較新的覆蓋本機
    let metaChanged = false;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('albums').select('key,data,deleted,updated_at').range(from, from + 999);
      if (error) throw error;
      data.forEach(r => {
        if (r.key === META_RS) {             // 最近搜尋：時間較新的一方為準
          const ts = Number(r.updated_at);
          if (ts > recentSearchesAt) { applyRemoteRecentSearches(r.data?.items, ts); delete db.dirty[META_RS]; metaChanged = true; }
          else if (ts === recentSearchesAt) delete db.dirty[META_RS];
          return;
        }
        if (r.key.startsWith('__meta:')) return;
        const k = r.key, localTs = db.albums[k]?.updatedAt ?? db.deleted[k] ?? 0, ts = Number(r.updated_at);
        if (ts > localTs) {
          if (r.deleted) { delete db.albums[k]; db.deleted[k] = ts; } else { db.albums[k] = r.data; delete db.deleted[k]; }
          delete db.dirty[k];
        } else if (ts === localTs) delete db.dirty[k];
      });
      if (data.length < 1000) break;
    }
    // 2. 推上本機有改過的
    const rows = Object.keys(db.dirty).map(k => k === META_RS
      ? { user_id: sbUser.id, key: k, data: { items: recentSearches }, deleted: false, updated_at: recentSearchesAt || Date.now() }
      : db.albums[k]
      ? { user_id: sbUser.id, key: k, data: db.albums[k], deleted: false, updated_at: db.albums[k].updatedAt || Date.now() }
      : { user_id: sbUser.id, key: k, data: {}, deleted: true, updated_at: db.deleted[k] || Date.now() });
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('albums').upsert(chunk, { onConflict: 'user_id,key' });
      if (error) throw error;
      chunk.forEach(r => delete db.dirty[r.key]);
    }
    db.lastSync = Date.now(); save();
    if (manual) toast('✓ 已同步');
    if (metaChanged && state.searchFocus && !state.q) updateSearchBody();
  } catch (e) { state.syncErr = e.message || String(e); if (manual) toast('同步失敗'); console.warn(e); }
  syncing = false;
  if (state.current || (state.tab === 'search' && !state.view)) { updateDot(); if (state.tab === 'search' && !state.view && !state.current && !state.searchFocus) updateSearchBody(); }
  else render();
}
function updateDot() {
  const d = $('#syncDot'); if (!d) return;
  d.className = 'dot ' + (syncing ? 'busy' : (sbUser && !state.syncErr ? '' : 'off'));
}

/* ================= 狀態 ================= */
const state = {
  tab: 'search', view: null, q: '', mode: 'album', results: null, loading: false,
  libFilter: null, sf: null, resKind: null, libQ: '', current: null, sp: {}, syncErr: '', login: {}
};
const seen = new Map();
function remember(list) { list.forEach(a => { const k = albumKey(a); const old = seen.get(k); seen.set(k, old ? { ...old, ...a, _tracks: old._tracks } : a); }); return list; }
const findAlbum = k => db.albums[k] || seen.get(k);
const typeLabel = t => ({ Album: '專輯', EP: 'EP', Single: '單曲', Compilation: '合輯' })[t] || t;
// 跟 Spotify 一樣的發行類型分組
const RELEASES = [['Album', '專輯'], ['SingleEP', '單曲和迷你專輯'], ['Compilation', '合輯']];
const inGroup = (a, g) => !g ? true : g === 'Album' ? a.type === 'Album' : g === 'SingleEP' ? (a.type === 'Single' || a.type === 'EP') : g === 'Compilation' ? a.type === 'Compilation' : true;
// Spotify 式單選標籤：選了一個就只留「✕＋已選的」，再點一次或按 ✕ 取消回到全部
function chipBar(scope, opts, sel, style = '') {
  const on = opts.find(([v]) => v === sel);
  return `<div class="chips" style="${style}">${on
    ? `<button class="chip x" data-f="${scope}" data-v="" aria-label="清除篩選">✕</button><button class="chip on" data-f="${scope}" data-v="">${on[1]}</button>`
    : opts.map(([v, l]) => `<button class="chip" data-f="${scope}" data-v="${v}">${l}</button>`).join('')}</div>`;
}

const I = {
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>',
  markOn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  archive: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.2"/><path d="M5 9v10.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V9M10 13.5h4"/></svg>',
  sort: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  flip: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>',
  v_grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  v_small: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="9.5" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><rect x="16" y="9.5" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><rect x="9.5" y="16" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/></svg>',
  v_list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="4" width="5" height="5" rx="1"/><rect x="3" y="15" width="5" height="5" rx="1"/><path d="M11 5.5h10M11 8h6M11 16.5h10M11 19h6"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m15 5-7 7 7 7"/></svg>'
};
const gearBtn = () => `<button class="icon-btn" data-act="menu" aria-label="設定">${I.gear}${syncOn() ? `<span id="syncDot" class="dot ${syncing ? 'busy' : (sbUser && !state.syncErr ? '' : 'off')}"></span>` : ''}</button>`;

/* ================= 畫面 ================= */
function render() {
  $('#app').classList.toggle('search-mode', state.tab === 'search' && !state.view && !!state.searchFocus);
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab && !state.view));
  const app = $('#app');
  if (state.view?.type === 'artist') return renderArtist(app);
  if (state.view?.type === 'archive') return renderArchive(app);
  ({ search: renderSearch, heard: renderLib, want: renderLib, artists: renderArtists })[state.tab](app);
}

function albumCard(a, no) {
  const k = albumKey(a), s = statusOf(k);
  return `<div class="card${s === 'archived' ? ' is-arch' : ''}" data-open="${esc(k)}">
    <div class="cover">
      ${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : '<div class="ph">♪</div>'}
      ${a.type !== 'Album' ? `<span class="badge">${typeLabel(a.type)}</span>` : ''}
      <div class="acts">
        ${!isDone(s) ? `<button class="mini ${s === 'want' ? 'want' : ''}" data-want="${esc(k)}" aria-label="想聽">${s === 'want' ? I.markOn : I.mark}</button>` : ''}
        ${s !== 'heard' ? `<button class="mini ${s === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}" aria-label="封存">${I.archive}</button>` : ''}
        <button class="mini ${s === 'heard' ? 'heard' : ''}" data-heard="${esc(k)}" aria-label="已聽過">${s === 'heard' ? I.check : I.check}</button>
      </div>
    </div>
    <div class="t">${no ? `<span class="no">#${no}</span>` : ''}${esc(a.title)}</div>
    <div class="a">${s === 'heard' ? '<span class="lbl-w"><span class="lbl heard">✓ 已聽過</span> · </span>' : s === 'want' ? '<span class="lbl-w"><span class="lbl want">想聽</span> · </span>' : s === 'archived' ? '<span class="lbl-w"><span class="lbl arch">已封存</span> · </span>' : ''}${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
  </div>`;
}

/* 列表式的一列 */
function albumRow(a, no) {
  const k = albumKey(a), s = statusOf(k);
  return `<div class="arow${s === 'archived' ? ' is-arch' : ''}" data-open="${esc(k)}">
    <span class="arow-no">${no}</span>
    <div class="arow-cover">${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : '<div class="ph" style="font-size:20px">♪</div>'}</div>
    <div class="arow-main">
      <div class="arow-t">${esc(a.title)}</div>
      <div class="arow-a">${esc(a.artist)}</div>
      <div class="arow-m">${typeLabel(a.type)}${a.year ? ' · ' + a.year : ''}</div>
    </div>
    <div class="arow-acts">
      ${!isDone(s) ? `<button class="mini ${s === 'want' ? 'want' : ''}" data-want="${esc(k)}" aria-label="想聽">${s === 'want' ? I.markOn : I.mark}</button>` : ''}
        ${s !== 'heard' ? `<button class="mini ${s === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}" aria-label="封存">${I.archive}</button>` : ''}
      <button class="mini ${s === 'heard' ? 'heard' : ''}" data-heard="${esc(k)}" aria-label="已聽過">${s === 'heard' ? I.check : I.check}</button>
    </div>
  </div>`;
}
const VIEWS = [['grid', '大圖示'], ['small', '小圖示'], ['list', '列表']];
function viewOf(st) { db.settings.view ??= {}; return db.settings.view[st] || 'grid'; }

/* ---------- 首頁（搜尋＋最近播放） ---------- */
// 搜尋結果區塊（只更新這塊，打字時輸入框不會被重畫、鍵盤也不會收起）
function searchBodyHTML() {
  const r = state.results;
  if (state.searchFocus && !r && !state.q) return recentSearchHTML();
  if (!r) return state.loading ? '<div class="spinner"></div>' : homeHTML();
  const artists = r.artists || [], albums = remember(r.albums || []);
  if (!artists.length && !albums.length) return state.loading ? '<div class="spinner"></div>' : '<div class="empty">找不到結果</div>';
  const img = x => x.images?.[x.images.length - 1]?.url || x.images?.[0]?.url || '';
  // 跟 Spotify 一樣：最相關的歌手在最上面，接著是專輯
  return `<div class="slist" style="margin-top:6px">
    ${artists.slice(0, 1).map(x => sRowArtist(x.name, x.id, img(x)) + '</div>').join('')}
    ${albums.map(a => sRowAlbum(a, albumKey(a)) + albumActs(albumKey(a)) + '</div>').join('')}
    ${artists.slice(1, 4).map(x => sRowArtist(x.name, x.id, img(x)) + '</div>').join('')}
  </div>`;
}
/* ---------- 最近搜尋（像 Spotify：記錄從搜尋結果點開的專輯／歌手，存在這台裝置） ---------- */
// 跨裝置同步：存在雲端 albums 表的一列特殊資料（key = META_RS），不會被當成專輯
const RS_KEY = 'heard.recentSearches', RS_AT = 'heard.recentSearchesAt', RS_MAX = 20, META_RS = '__meta:recentSearches';
let recentSearches = (() => { try { return JSON.parse(localStorage.getItem(RS_KEY)) || []; } catch (e) { return []; } })();
let recentSearchesAt = +(localStorage.getItem(RS_AT) || 0);
function saveRecentSearches() {
  recentSearchesAt = Date.now();
  try { localStorage.setItem(RS_KEY, JSON.stringify(recentSearches)); localStorage.setItem(RS_AT, String(recentSearchesAt)); } catch (e) {}
  db.dirty[META_RS] = 1; save(); scheduleSync();
}
function applyRemoteRecentSearches(items, ts) {
  recentSearches = Array.isArray(items) ? items.slice(0, RS_MAX) : []; recentSearchesAt = ts;
  try { localStorage.setItem(RS_KEY, JSON.stringify(recentSearches)); localStorage.setItem(RS_AT, String(ts)); } catch (e) {}
}
function addRecentSearch(item) {
  const id = item.type + ':' + (item.type === 'album' ? item.key : norm(item.name));
  recentSearches = [{ ...item, id }, ...recentSearches.filter(x => x.id !== id)].slice(0, RS_MAX);
  saveRecentSearches();
}
const xIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function sRowAlbum(a, k, extra = '') {
  const s = statusOf(k);
  return `<div class="srow${s === 'archived' ? ' is-arch' : ''}" data-open="${esc(k)}"${extra}>
    <div class="srow-img">${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : '<div class="ph" style="font-size:22px">♪</div>'}</div>
    <div class="srow-txt"><div class="srow-t">${esc(a.title)}</div><div class="srow-s">${s === 'heard' ? '<span class="lbl heard">已聽過</span> • ' : s === 'want' ? '<span class="lbl want">想聽</span> • ' : s === 'archived' ? '<span class="lbl arch">已封存</span> • ' : ''}${typeLabel(a.type)} • ${esc(a.artist)}</div></div>`;
}
function sRowArtist(name, id, img, extra = '') {
  return `<div class="srow" data-artist="${esc(id || '')}" data-name="${esc(name)}"${extra}>
    <div class="srow-img round">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<span>${esc(name[0])}</span>`}</div>
    <div class="srow-txt"><div class="srow-t">${esc(name)}</div><div class="srow-s">歌手</div></div>`;
}
const albumActs = k => { const s = statusOf(k); return `<div class="srow-acts">
  ${!isDone(s) ? `<button class="mini ${s === 'want' ? 'want' : ''}" data-want="${esc(k)}" aria-label="想聽">${s === 'want' ? I.markOn : I.mark}</button>` : ''}
  ${s !== 'heard' ? `<button class="mini ${s === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}" aria-label="封存">${I.archive}</button>` : ''}
  <button class="mini ${s === 'heard' ? 'heard' : ''}" data-heard="${esc(k)}" aria-label="已聽過">${I.check}</button></div>`; };
function recentSearchHTML() {
  if (!recentSearches.length) return '';
  return `<div class="s-title">最近搜尋</div><div class="slist">${recentSearches.map((x, i) => {
    const xb = `<button class="srow-x" data-rmrecent="${i}" aria-label="移除">${xIcon}</button></div>`;
    if (x.type === 'album') { remember([x.album]); return sRowAlbum(x.album, x.key, ' data-rs="1"') + xb; }
    return sRowArtist(x.name, x.artistId, x.img, ' data-rs="1"') + xb;
  }).join('')}</div>
  <div style="text-align:center"><button class="s-clear" data-act="clearRecent">清除最近搜尋</button></div>`;
}

function updateSearchBody() {
  const el = $('#sres');
  if (el && state.tab === 'search' && !state.view) el.innerHTML = searchBodyHTML(); else render();
}
let searchT = null, searchSeq = 0;
function renderSearch(app) {
  app.innerHTML = `
    <div class="home-head"><header class="top"><h1>首頁</h1>${gearBtn()}</header></div>
    <div class="search-row${state.searchFocus ? ' focus' : ''}">
      <form class="search" id="sform"><svg class="s-ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg><input id="q" type="search" enterkeyhint="search" placeholder="你想收聽什麼？" value="${esc(state.q)}" autocomplete="off" autocorrect="off" spellcheck="false"></form>
      <button class="text-btn search-cancel" data-act="searchCancel">取消</button>
    </div>
    <div id="sres">${searchBodyHTML()}</div>`;
  $('#sform').onsubmit = e => { e.preventDefault(); $('#q').blur(); clearTimeout(searchT); doSearch($('#q').value.trim()); };
  // 跟 Spotify 一樣邊打邊搜尋
  $('#q').addEventListener('input', e => {
    const q = e.target.value.trim();
    clearTimeout(searchT);
    if (!q) { searchSeq++; state.results = null; state.q = ''; state.loading = false; updateSearchBody(); return; }
    searchT = setTimeout(() => doSearch(q), 350);
  });
  const onFocus = () => {
    if (state.searchFocus) return;
    state.searchFocus = true;
    enterSearchMode();
  };
  $('#q').addEventListener('focus', onFocus);
  $('#q').addEventListener('pointerdown', onFocus);
  if (!state.results && !state.loading && spOn()) loadSpotifyHome();
}
function endSearch() {
  clearTimeout(searchT); searchSeq++;
  state.searchFocus = false; state.results = null; state.q = ''; state.loading = false;
  const q = $('#q'); if (q) { q.value = ''; q.blur(); }
  exitSearchMode();
}
/* 搜尋轉場（FLIP）：先用 transform 把搜尋列和內容滑上去、標題淡出，動畫結束才真正收起標題，
   全程不改版面高度，所以不會掉幀。時間 0.65 秒、iOS 系統彈簧感曲線 cubic-bezier(.32,.72,0,1) */
const SM_MS = 650, SM_EASE = 'cubic-bezier(.32,.72,0,1)';
let smT = null;
function smEls() { return { app: $('#app'), head: $('.home-head'), row: $('.search-row'), res: $('#sres') }; }
function smClear(...els) { els.forEach(e => { if (e) { e.style.transition = ''; e.style.transform = ''; e.style.opacity = ''; } }); }
function enterSearchMode() {
  const { app, head, row, res } = smEls(); if (!head || !row) return;
  clearTimeout(smT);
  const h = head.offsetHeight + parseFloat(getComputedStyle(head.firstElementChild).marginBottom || 0);
  row.classList.add('focus');
  if (!state.q) { res.style.opacity = '0'; res.innerHTML = searchBodyHTML(); }
  void row.offsetHeight;
  head.style.transition = `opacity ${SM_MS * .6}ms ${SM_EASE}, transform ${SM_MS}ms ${SM_EASE}`;
  head.style.opacity = '0'; head.style.transform = 'translateY(-10px)';
  [row, res].forEach(e => { e.style.transition = `transform ${SM_MS}ms ${SM_EASE}, opacity ${SM_MS}ms ${SM_EASE}`; e.style.transform = `translateY(${-h}px)`; });
  res.style.opacity = '1';
  smT = setTimeout(() => {               // 動畫結束：真正收起標題，同一格移除位移，畫面不會跳
    [head, row, res].forEach(e => { e.style.transition = 'none'; });
    app.classList.add('search-mode');
    smClear(head, row, res);
  }, SM_MS + 20);
}
function exitSearchMode() {
  const { app, head, row, res } = smEls();
  clearTimeout(smT);
  if (!head || !row) { app.classList.remove('search-mode'); return updateSearchBody(); }
  [head, row, res].forEach(e => { e.style.transition = 'none'; });
  app.classList.remove('search-mode');
  row.classList.remove('focus');
  const h = head.offsetHeight + parseFloat(getComputedStyle(head.firstElementChild).marginBottom || 0);
  head.style.opacity = '0'; head.style.transform = 'translateY(-10px)';
  row.style.transform = res.style.transform = `translateY(${-h}px)`;
  res.style.opacity = '0'; res.innerHTML = searchBodyHTML();
  void row.offsetHeight;
  head.style.transition = `opacity ${SM_MS}ms ${SM_EASE}, transform ${SM_MS}ms ${SM_EASE}`;
  [row, res].forEach(e => { e.style.transition = `transform ${SM_MS}ms ${SM_EASE}, opacity ${SM_MS}ms ${SM_EASE}`; });
  head.style.opacity = '1'; head.style.transform = '';
  row.style.transform = res.style.transform = ''; res.style.opacity = '1';
  smT = setTimeout(() => smClear(head, row, res), SM_MS + 20);
}

function homeHTML() {
  if (!spOn()) return `<div class="panel" style="text-align:center;margin-top:8px">
      <b>連結 Spotify</b><div class="muted small" style="margin:4px 0 12px">搜尋、歌手作品和最近播放都來自 Spotify，連結後才能使用</div>
      <button class="btn primary" data-act="spLogin">連結 Spotify</button></div>`;
  const s = state.sp;
  const sec = (title, inner, extra = '') => `<div class="section-h"><span>${title}</span>${extra}</div>${inner}`;
  const recent = s.recent === undefined ? '<div class="spinner sm"></div>'
    : s.recent.filter(a => inGroup(a, state.sf)).length ? `<div class="grid">${s.recent.filter(a => inGroup(a, state.sf)).map(a => albumCard(a)).join('')}</div>` : '<div class="muted small">沒有最近播放紀錄</div>';
  return `${s.err ? `<div class="panel err">${esc(s.err)}</div>` : ''}
    ${sec('最近播放的專輯', recent)}`;
}

let spLoading = false;
async function loadSpotifyHome(force) {
  if (spLoading) return;
  const s = state.sp;
  if (!force && s.loadedAt && Date.now() - s.loadedAt < 60000) return;
  spLoading = true; s.loadedAt = Date.now(); s.err = '';
  const tasks = [
    spRecent().then(v => s.recent = v)
  ];
  const res = await Promise.allSettled(tasks);
  const fail = res.find(x => x.status === 'rejected');
  if (fail) { s.err = fail.reason.message; s.recent ??= []; }
  spLoading = false;
  if (state.tab === 'search' && !state.view && !state.results && !state.current) updateSearchBody();
}
async function doSearch(q) {
  if (!q) return;
  if (!spOn()) return toast('請先連結 Spotify');
  if (q === state.q && state.results && !state.loading) return;
  const seq = ++searchSeq;
  state.q = q; state.loading = true;
  if (!state.results) updateSearchBody();
  const [al, ar] = await Promise.allSettled([searchAlbums(q), searchArtistsTop(q)]);
  if (seq !== searchSeq) return;               // 已經有更新的搜尋，丟掉舊結果
  state.loading = false;
  state.results = { albums: al.status === 'fulfilled' ? al.value : [], artists: ar.status === 'fulfilled' ? ar.value : [] };
  if (al.status === 'rejected' && ar.status === 'rejected') toast(al.reason?.message || '連線失敗，請稍後再試');
  updateSearchBody();
}

/* ---------- 已聽過 / 想聽 ---------- */
function renderLib(app) {
  const status = state.tab;
  let list = Object.values(db.albums).filter(a => a.status === status);
  const total = list.length, artists = new Set(list.map(a => norm(a.artist))).size;
  if (state.libFilter) list = list.filter(a => inGroup(a, state.libFilter));
  if (state.libQ) { const q = state.libQ.toLowerCase(); list = list.filter(a => (a.title + ' ' + a.artist).toLowerCase().includes(q)); }
  const so = sortOf(status), sdef = sortsFor(status)[so.key];
  list.sort((a, b) => { const r = sdef.cmp(a, b, status) || timeOf(a, status) - timeOf(b, status); return so.desc ? -r : r; });
  remember(list);
  const isH = status === 'heard';
  const view = viewOf(status);
  app.innerHTML = `
    <header class="top"><div><h1>${isH ? '已聽過' : '想聽'}</h1><div class="sub">${total} 張唱片 · ${artists} 位歌手</div></div>${gearBtn()}</header>
    ${total ? `<div class="search">${I.search}<input id="lq" type="search" placeholder="在${isH ? '已聽過' : '想聽'}裡搜尋" value="${esc(state.libQ)}"></div>
    ${chipBar('lib', RELEASES, state.libFilter)}
    <div class="row-between" style="margin-bottom:12px">
      <button class="sort-btn" data-act="sortMenu">${I.sort}<span>${sdef.label(status)}</span></button>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="seg" role="group" aria-label="檢視方式">${VIEWS.map(([v, l]) => `<button class="${view === v ? 'on' : ''}" data-view="${v}" aria-label="${l}" title="${l}">${I['v_' + v]}</button>`).join('')}</div>
        <button class="icon-btn" data-act="sortFlip" aria-label="反轉順序" style="width:34px;height:34px">${I.flip}</button>
      </div>
    </div>
    ${!list.length ? '<div class="empty">沒有符合的唱片</div>'
      : view === 'list' ? `<div class="alist">${list.map((a, i) => albumRow(a, list.length - i)).join('')}</div>`
      : `<div class="grid ${view === 'small' ? 'small' : ''}">${list.map((a, i) => albumCard(a, list.length - i)).join('')}</div>`}`
    : `<div class="empty"><b>${isH ? '還沒有已聽過的唱片' : '想聽清單是空的'}</b>到「首頁」找專輯，點 <span class="inline-ic">${isH ? I.check : I.mark}</span> ${isH ? '標記已聽過' : '加入想聽'}</div>`}
    ${isH && archiveCount() ? `<button class="archive-link" data-act="archive">${I.archive}已封存 ${archiveCount()} 張 ›</button>` : ''}`;
  const lq = $('#lq'); if (lq) lq.oninput = e => { state.libQ = e.target.value; const pos = e.target.selectionStart; render(); const n = $('#lq'); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ---------- 排序 ---------- */
const colStroke = new Intl.Collator('zh-Hant-TW-u-co-stroke', { numeric: true, sensitivity: 'base' });
const timeOf = (a, st) => (st === 'heard' ? a.heardAt : a.addedAt) || a.addedAt || 0;
// 每個排序：cmp 是「遞增」比較；dirs[0] 是遞增的說法、dirs[1] 是遞減；def 為預設是否遞減
const SORTS = {
  time:   { label: st => st === 'heard' ? '聽過時間' : '加入時間', dirs: ['舊 → 新', '新 → 舊'], def: true,  cmp: (a, b, st) => timeOf(a, st) - timeOf(b, st) },
  title:  { label: () => '專輯名稱', dirs: ['少 → 多', '多 → 少'], def: false, cmp: (a, b) => colStroke.compare(a.title, b.title) },
  artist: { label: () => '歌手',     dirs: ['少 → 多', '多 → 少'], def: false, cmp: (a, b) => colStroke.compare(a.artist, b.artist) || (a.year || '').localeCompare(b.year || '') }
};
// 歌手頁的排序：筆畫、聽過進度
const ARTIST_SORTS = {
  pct:  { label: () => '聽過進度', dirs: ['低 → 高', '高 → 低'], def: true,  cmp: (a, b) => (a.pg ? a.pg.pct : -1) - (b.pg ? b.pg.pct : -1) || (a.pg?.heard || a.heard.length) - (b.pg?.heard || b.heard.length) },
  name: { label: () => '歌手',     dirs: ['少 → 多', '多 → 少'], def: false, cmp: (a, b) => colStroke.compare(a.name, b.name) }
};
const sortsFor = st => st === 'artists' ? ARTIST_SORTS : SORTS;
function sortOf(st) {
  db.settings.sort ??= {};
  const s = db.settings.sort[st], S = sortsFor(st);
  return s && S[s.key] ? s : (st === 'artists' ? { key: 'pct', desc: true } : { key: 'time', desc: true });
}
function setSort(st, key) {
  const cur = sortOf(st);
  db.settings.sort[st] = cur.key === key ? { key, desc: !cur.desc } : { key, desc: sortsFor(st)[key].def };
  save();
}
function openSortMenu() {
  state.current = null;
  const st = state.tab, cur = sortOf(st);
  $('#sheet').innerHTML = `<div class="grab"></div><h2 style="margin:0 0 8px">排序方式</h2>
    <div class="list">${Object.entries(sortsFor(st)).map(([k, o]) => {
      const on = cur.key === k;
      return `<button class="li sort-opt ${on ? 'on' : ''}" data-sort="${k}">
        <div class="grow"><div class="name">${o.label(st)}</div></div>
        ${on ? `<span class="sort-check">${I.check}</span>` : ''}</button>`;
    }).join('')}</div>`;
  showSheet();
}

/* ---------- 封存 ---------- */
function renderArchive(app) {
  const list = remember(Object.values(db.albums).filter(a => a.status === 'archived').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  app.innerHTML = `<button class="back" data-act="back">${I.back}返回</button>
    <header class="top"><div><h1>已封存</h1><div class="sub">${list.length} 張唱片</div></div></header>
    ${list.length ? `<div class="grid small">${list.map(a => albumCard(a)).join('')}</div>`
      : '<div class="empty">沒有封存的唱片</div>'}`;
}
const archiveCount = () => Object.values(db.albums).filter(a => a.status === 'archived').length;

/* ---------- 歌手 ---------- */
// 刪除歌手＝移除這位歌手所有的標記（已聽過／想聽／封存），會同步到雲端
async function deleteArtist(name) {
  const albums = Object.values(db.albums).filter(a => norm(a.artist) === norm(name));
  if (!albums.length) return;
  const n = st => albums.filter(a => a.status === st).length;
  const parts = [['heard', '已聽過'], ['want', '想聽'], ['archived', '封存']].filter(([st]) => n(st)).map(([st, l]) => `${l} ${n(st)}`);
  const ok = await ask({
    title: `刪除「${name}」？`,
    msg: `會移除這位歌手全部 ${albums.length} 張的標記（${parts.join('、')}），無法復原。`,
    ok: '刪除', cancel: '取消'
  });
  if (!ok) { closeSwipes(); return; }
  const now = Date.now();
  albums.forEach(a => { const k = albumKey(a); delete db.albums[k]; db.deleted[k] = now; db.dirty[k] = 1; });
  delete artistTotals[norm(name)];
  try { localStorage.setItem(AT_KEY, JSON.stringify(artistTotals)); } catch (e) {}
  save(); scheduleSync();
  render(); toast(`已刪除「${name}」`);
}
function closeSwipes(except) {
  document.querySelectorAll('.sw.open').forEach(el => { if (el !== except) el.classList.remove('open'); });
}
// 左滑顯示刪除（類似 iOS）
(() => {
  let row = null, fg = null, x0 = 0, y0 = 0, dx = 0, mode = null, base = 0;
  document.addEventListener('touchstart', e => {
    const f = e.target.closest('.sw-fg'); if (!f) { row = null; return; }
    fg = f; row = f.parentElement; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null;
    base = row.classList.contains('open') ? -88 : 0;
    closeSwipes(row);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!row) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (!mode) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; mode = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'; }
    if (mode !== 'x') return;
    e.preventDefault();
    dx = Math.min(0, Math.max(-120, base + mx));
    fg.style.transition = 'none'; fg.style.transform = `translateX(${dx}px)`;
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (!row || mode !== 'x') { row = null; return; }
    fg.style.transition = ''; fg.style.transform = '';
    row.classList.toggle('open', dx < -44);
    row.dataset.justSwiped = '1'; setTimeout(() => { if (row) delete row.dataset.justSwiped; }, 350);
    row = null;
  });
})();
/* 歌手完整作品數的快取（只存在這台裝置），讓歌手列表不用點進去就能看到聽過百分比 */
const AT_KEY = 'heard.artistTotals', AT_TTL = 3 * 864e5;
const artistTotals = (() => { try { return JSON.parse(localStorage.getItem(AT_KEY)) || {}; } catch (e) { return {}; } })();
function setArtistTotal(name, id, albums) {
  artistTotals[norm(name)] = { id, keys: albums.map(albumKey), at: Date.now() };
  try { localStorage.setItem(AT_KEY, JSON.stringify(artistTotals)); } catch (e) {}
}
// 歌手列表與歌手頁共用：同一位歌手用同一個 Spotify id、同一套算法，數字才會一致
function rowArtistId(name) {
  let id = '';
  Object.values(db.albums).forEach(a => { if (norm(a.artist) === norm(name) && a.artistId) id = a.artistId; });
  return id;
}
function statsFor(name, discKeys) {
  const local = Object.values(db.albums).filter(a => norm(a.artist) === norm(name));
  const all = new Set([...discKeys, ...local.map(albumKey)]);
  const heard = [...all].filter(k => isDone(statusOf(k))).length;
  const want = [...all].filter(k => statusOf(k) === 'want').length;
  return { heard, want, total: all.size, pct: all.size ? Math.round(heard / all.size * 100) : 0 };
}
function artistProgress(name) {
  const c = artistTotals[norm(name)]; if (!c) return null;
  return statsFor(name, c.keys);
}
const atQueue = new Set(); let atRunning = 0, atRenderT = null;
function queueArtistTotal(name, id) {
  const c = artistTotals[norm(name)];
  if (!spOn() || atQueue.has(name) || (c && Date.now() - c.at < AT_TTL)) return;
  atQueue.add(name); pumpArtistTotals(id);
}
async function pumpArtistTotals() {
  while (atRunning < 2 && atQueue.size) {
    const name = atQueue.values().next().value; atQueue.delete(name); atRunning++;
    (async () => {
      try {
        const started = Date.now();
        const rid = rowArtistId(name);
        const id = isSpId(rid) ? rid : await resolveArtistId(name);
        const albums = id ? await artistAlbums(id) : null;
        // 如果這段時間使用者已經點進歌手頁更新過，就不要覆蓋
        if (albums && !((artistTotals[norm(name)]?.at || 0) > started)) setArtistTotal(name, id, albums);
      } catch (e) {}
      atRunning--;
      clearTimeout(atRenderT);
      atRenderT = setTimeout(() => { if (state.tab === 'artists' && !state.view && !state.current) render(); }, 400);
      pumpArtistTotals();
    })();
  }
}

function renderArtists(app) {
  const map = new Map();
  // 規則：封存的專輯不會讓歌手出現在歌手列表（但歌手已在列表時，封存仍算進進度）
  Object.values(db.albums).filter(a => a.status !== 'archived').forEach(a => {
    const k = norm(a.artist);
    if (!map.has(k)) map.set(k, { id: '', name: a.artist, heard: [], want: [] });
    const g = map.get(k); if (a.artistId) g.id = a.artistId;   // 與 rowArtistId 規則相同
    g[a.status === 'want' ? 'want' : 'heard'].push(a);
  });
  const list = [...map.values()];
  list.forEach(x => { x.pg = artistProgress(x.name); });
  const so = sortOf('artists'), sdef = ARTIST_SORTS[so.key];
  list.sort((a, b) => { const r = sdef.cmp(a, b) || colStroke.compare(a.name, b.name); return so.desc ? -r : r; });
  app.innerHTML = `
    <header class="top"><div><h1>歌手</h1>${list.length ? `<div class="sub">${list.length} 位歌手</div>` : ''}</div>${gearBtn()}</header>
    ${list.length ? `<div class="row-between" style="margin-bottom:6px">
      <button class="sort-btn" data-act="sortMenu">${I.sort}<span>${sdef.label()}</span></button>
      <button class="icon-btn" data-act="sortFlip" aria-label="反轉順序" style="width:34px;height:34px">${I.flip}</button>
    </div>` : ''}
    ${list.length ? `<div class="list">${list.map(x => {
      const c = (x.heard[0] || x.want[0]).cover;
      const pg = x.pg;
      if (!pg || Date.now() - artistTotals[norm(x.name)].at > AT_TTL) queueArtistTotal(x.name);
      return `<div class="sw">
        <button class="sw-del" data-delartist="${esc(x.name)}">刪除</button>
        <button class="li sw-fg" data-artist="${x.id}" data-name="${esc(x.name)}">
        <div class="av">${c ? `<img src="${esc(c)}" alt="">` : esc(x.name[0])}</div>
        <div class="grow"><div class="row-between"><div class="name">${esc(x.name)}</div>${pg ? `<b class="pct">${pg.pct}%</b>` : ''}</div>
          <div class="muted small">${pg ? `聽過 ${pg.heard} / ${pg.total} 張` : `已聽 ${x.heard.length} 張${spOn() ? ' · 計算中…' : ''}`}${x.want.length ? ` · 想聽 ${x.want.length} 張` : ''}</div>
          ${pg ? `<div class="bar"><i style="width:${pg.pct}%"></i></div>` : ''}</div>
        <span class="muted">›</span></button></div>`;
    }).join('')}</div>`
    : `<div class="empty"><b>還沒有歌手</b>標記第一張專輯後，歌手會出現在這裡</div>`}`;
}

async function renderArtist(app) {
  const v = state.view;
  const head = `<button class="back" data-act="back">${I.back}返回</button>`;
  const local = Object.values(db.albums).filter(a => norm(a.artist) === norm(v.name));
  if (!v.albums) {
    app.innerHTML = `${head}<h2 style="margin:4px 0">${esc(v.name)}</h2><div class="spinner"></div>`;
    try {
      if (!spOn()) v.albums = [];
      else {
        if (!isSpId(v.id)) v.id = await resolveArtistId(v.name);
        v.albums = v.id ? await artistAlbums(v.id) : [];
      }
    } catch (e) { v.albums = []; toast(e.message || '載入失敗'); }
    if (state.view !== v) return;
  }
  if (v.albums.length && !v.cached) { setArtistTotal(v.name, v.id, v.albums); v.cached = true; }
  const st = statsFor(v.name, v.albums.map(albumKey));
  const keys = new Set(v.albums.map(albumKey));
  const own = remember([...v.albums, ...local.filter(a => !keys.has(albumKey(a)))]);
  const ARTIST_OPTS = RELEASES;
  const all = own.filter(a => inGroup(a, v.filter));
  const groups = v.filter ? [[v.filter, ARTIST_OPTS.find(o => o[0] === v.filter)[1]]] : RELEASES;
  const counted = all;
  // 沒有篩選時直接用共用算法（跟歌手列表一致）；有篩選時算該分類
  const heard = v.filter ? counted.filter(a => isDone(statusOf(albumKey(a)))).length : st.heard;
  const want = v.filter ? counted.filter(a => statusOf(albumKey(a)) === 'want').length : st.want;
  const totalN = v.filter ? counted.length : st.total;
  const pct = totalN ? Math.round(heard / totalN * 100) : 0;
  const cover = all.find(a => a.cover)?.cover;
  app.innerHTML = `${head}
    <div class="artist-hero">
      <div class="av">${cover ? `<img src="${esc(cover)}" alt="">` : ''}</div>
      <div style="flex:1;min-width:0"><h2>${esc(v.name)}</h2>
        <div class="row-between"><span class="muted small">聽過 ${heard} / ${totalN} 張${want ? ` · 想聽 ${want}` : ''}</span><b style="font-size:18px">${pct}%</b></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
    </div>
    ${chipBar('artist', ARTIST_OPTS, v.filter || null, 'margin-bottom:4px')}
    ${groups.map(([t, l]) => {
      const g = all.filter(a => inGroup(a, t));
      if (!g.length) return '';
      const h = g.filter(a => isDone(statusOf(albumKey(a)))).length;
      return `<div class="section-h"><span>${l} · ${h}/${g.length}</span></div><div class="grid">${g.map(a => albumCard(a)).join('')}</div>`;
    }).join('')}
    ${!all.length ? '<div class="empty">這個分類沒有作品</div>' : ''}`;
}

/* ================= 專輯詳情 ================= */
// 總時長：1 小時 12 分 / 42 分 18 秒
function fmtTotal(ms) {
  const sec = Math.round(ms / 1000), h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s2 = sec % 60;
  return h ? `${h} 小時 ${m} 分` : `${m} 分 ${s2} 秒`;
}
let sheetOpenedAt = 0, sheetToken = 0;
function showSheet() {
  const s = $('#sheet');
  s.scrollTop = 0;
  if (s.classList.contains('show')) return;
  void s.offsetHeight;               // 先排版好內容，下一個畫格才開始滑入，避免第一格卡頓
  sheetOpenedAt = performance.now();
  const tk = ++sheetToken;
  const go = () => {
    if (tk !== sheetToken || s.classList.contains('show')) return;
    $('#scrim').classList.add('show'); s.classList.add('show');
  };
  requestAnimationFrame(go); setTimeout(go, 40);   // 背景分頁不跑 rAF 時的保險
}
// 等打開動畫結束後才做的事（避免動畫途中重排畫面）
function afterSheetOpen(fn) { setTimeout(fn, Math.max(0, 440 - (performance.now() - sheetOpenedAt))); }
function hideSheet() {
  sheetToken++;
  $('#scrim').classList.remove('show'); $('#sheet').classList.remove('show');
  state.current = null;
}
// 關閉選單；rerender=true 時等收回動畫結束才重畫底下頁面，避免收回途中畫面閃動
function closeSheet(rerender) { hideSheet(); if (rerender === true) setTimeout(render, 340); }

async function loadTracks(k) {
  const a = findAlbum(k); if (!a || a._tracks || a.manual) return;
  try {
    let t = [];
    if (spOn()) {
      if (!a.spotifyId) {           // 舊資料：補上 Spotify 的 id、封面與資訊
        const hit = await resolveAlbum(a);
        if (hit) {
          const upd = { spotifyId: hit.spotifyId, cover: hit.cover, artistId: hit.artistId, date: hit.date, year: hit.year || a.year, tracks: hit.tracks || a.tracks, type: hit.type };
          Object.assign(a, upd);
          const sv = seen.get(k); if (sv && sv !== a) Object.assign(sv, upd);
          if (db.albums[k]) { delete db.albums[k].appleUrl; touch(k); }
        }
      }
      if (a.spotifyId) t = await albumTracks(a.spotifyId);
    }
    const s = seen.get(k); if (s) s._tracks = t; else seen.set(k, { ...a, _tracks: t });
    if (state.current === k) afterSheetOpen(() => applyTracks(k));
  } catch (e) {
    const s = seen.get(k); if (s && !s._tracks) { s._tracks = []; if (state.current === k) afterSheetOpen(() => applyTracks(k)); }
  }
}
async function openAlbum(k) {
  if (!findAlbum(k)) return;
  state.current = k; renderSheet();
  // 封面通常已在列表載入過，直接開；還沒載入才稍等解碼（最多 80ms），避免滑到一半才解圖
  const img = $('#sheet .detail-cover img');
  if (img && !img.complete && img.decode) await Promise.race([img.decode().catch(() => {}), sleep(80)]);
  if (state.current !== k) return;
  showSheet(); loadTracks(k);
}
function metaHTML(a, tracks) {
  const totalMs = (tracks || []).reduce((t, x) => t + (x.ms || 0), 0);
  const n = tracks?.length || a.tracks;
  return `${typeLabel(a.type)}${a.year ? ' · ' + a.year : ''}${n ? ' · ' + n + ' 首' : ''}${totalMs ? ' · ' + fmtTotal(totalMs) : tracks === undefined && !a.manual ? ' · <span class="muted">計算時長…</span>' : ''}`;
}
function tracksHTML(tracks) {
  const fmt = ms => ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '';
  return (tracks || []).map(t => `<div><span>${t.n}</span><b style="flex:1;font-weight:400">${esc(t.name)}</b><em class="muted small" style="font-style:normal">${fmt(t.ms)}</em></div>`).join('');
}
// 曲目載入完成：只更新資訊列與曲目區，面板其他部分（封面、按鈕）不重建
function applyTracks(k) {
  if (state.current !== k) return;
  const a = db.albums[k] || seen.get(k); if (!a) return;
  const tracks = seen.get(k)?._tracks;
  const m = $('#sheetMeta'); if (m) m.innerHTML = metaHTML(a, tracks);
  const img = $('#sheet .detail-cover img'); if (img && a.cover && img.getAttribute('src') !== a.cover) img.src = a.cover;
  const t = $('#sheetTracks');
  if (t && tracks?.length && !t.childElementCount) { t.innerHTML = tracksHTML(tracks); void t.offsetHeight; t.classList.add('in'); }
}
function renderSheet() {
  const k = state.current; const saved = db.albums[k]; const a = saved || seen.get(k); if (!a) return;
  const keepImg = $('#sheet .detail-cover img');
  const keepTop = $('#sheet').scrollTop;
  queueMicrotask(() => {
    const ph = $('#sheet .detail-cover img');
    if (keepImg && ph && keepImg.src === ph.src && keepImg !== ph) ph.replaceWith(keepImg);
    $('#sheet').scrollTop = keepTop;
  });
  const st = saved?.status || null;
  const tracks = seen.get(k)?._tracks;
  $('#sheet').innerHTML = `<div class="grab"></div><div class="detail">
    ${state.npKey === k && state.sp.np ? `<div style="text-align:center;margin:-4px 0 10px" class="small muted">${state.sp.np.playing ? '<span class="eq"><i></i><i></i><i></i></span>正在播放' : '⏸ 暫停中'}：${esc(state.sp.np.track)}</div>` : ''}
    <div class="detail-cover${st === 'archived' ? ' is-arch' : ''}">${a.cover ? `<img src="${esc(a.cover)}" alt="">` : '<div class="ph" style="font-size:60px">♪</div>'}</div>
    <h2>${esc(a.title)}</h2>
    <div class="by"><button data-artist="${a.artistId || ''}" data-name="${esc(a.artist)}" style="color:inherit;font-weight:inherit">${esc(a.artist)} ›</button></div>
    <div class="meta" id="sheetMeta">${metaHTML(a, tracks)}</div>
    <div class="two">
      <button class="big-btn ${st === 'want' ? 'want' : ''}" data-want="${esc(k)}">${st === 'want' ? I.markOn : I.mark} 想聽</button>
      <button class="big-btn ${st === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}">${I.archive} 封存</button>
      <button class="big-btn ${st === 'heard' ? 'heard' : 'solid'}" data-heard="${esc(k)}">${I.check} 已聽過</button>
    </div>
    <div class="tracks${tracks?.length ? ' in' : ''}" id="sheetTracks">${tracksHTML(tracks)}</div>
  </div>`;
}

/* ================= 設定選單 ================= */
function openMenu() {
  state.current = null;
  const L = state.login;
  const syncBlock = !syncOn() ? '<div class="muted small">尚未設定雲端同步（見 SETUP.md）</div>'
    : !sb ? '<div class="spinner sm"></div>'
    : sbUser ? `<div class="panel"><div class="row-between"><div><b>${esc(sbUser.email)}</b>
        <div class="muted small">${syncing ? '同步中…' : state.syncErr ? '同步失敗：' + esc(state.syncErr) : db.lastSync ? '上次同步 ' + new Date(db.lastSync).toLocaleString('zh-TW', { hour12: false }) : '尚未同步'}</div></div>
        <button class="btn sm" data-act="syncNow">立即同步</button></div>
        <div style="margin-top:10px"><button class="btn sm" data-act="logout">登出</button></div></div>`
    : `<div class="panel"><div class="small muted">登入後，手機和電腦會自動同步。第一次使用請按「註冊」，之後每台裝置都用同一組帳密登入。</div>
        <form id="loginForm" style="margin-top:8px">
          <input id="email" type="email" autocomplete="email" placeholder="Email" value="${esc(L.email || '')}" required>
          <input id="pw" type="password" autocomplete="current-password" placeholder="密碼（至少 6 個字）" minlength="6" required style="margin-top:8px">
          <div class="btn-row"><button class="btn" type="submit" name="signup">註冊</button><button class="btn primary" type="submit">登入</button></div>
        </form>
        ${L.err ? `<div class="err">${esc(L.err)}</div>` : ''}</div>`;
  const spBlock = !CFG.SPOTIFY_CLIENT_ID ? '<div class="muted small">尚未設定 Spotify（見 SETUP.md）</div>'
    : spOn() ? `<div class="panel row-between"><span>✓ 已連結 Spotify</span><button class="btn sm" data-act="spLogout">中斷連結</button></div>`
    : `<button class="btn primary" data-act="spLogin">連結 Spotify</button>`;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin:0">設定</h2>
    <div class="menu-h">雲端同步</div>${syncBlock}
    <div class="menu-h">SPOTIFY</div>${spBlock}
    <div class="menu-h">資料</div>
    <div class="list">
      <button class="li" data-act="archive"><div class="grow"><div class="name">已封存的唱片</div><div class="muted small">${archiveCount()} 張 · 封存的唱片在歌手進度中算作已聽過</div></div></button>
      <button class="li" data-act="manual"><div class="grow"><div class="name">手動新增唱片</div><div class="muted small">搜不到的獨立發行或實體 CD</div></div></button>
      <button class="li" data-act="export"><div class="grow"><div class="name">匯出備份</div><div class="muted small">下載 JSON 檔</div></div></button>
      <button class="li" data-act="import"><div class="grow"><div class="name">匯入備份</div><div class="muted small">合併到目前的資料</div></div></button>
    </div>
`;
  showSheet();
  const lf = $('#loginForm'); if (lf) lf.onsubmit = async e => {
    e.preventDefault(); L.err = '';
    const signup = e.submitter?.name === 'signup';
    L.email = $('#email').value.trim();
    const cred = { email: L.email, password: $('#pw').value };
    e.submitter && (e.submitter.disabled = true);
    const { data, error } = signup ? await sb.auth.signUp(cred) : await sb.auth.signInWithPassword(cred);
    if (error) {
      L.err = /invalid login/i.test(error.message) ? 'Email 或密碼錯誤（還沒註冊的話請先按「註冊」）'
        : /already registered/i.test(error.message) ? '這個 Email 已經註冊過了，請直接按「登入」' : error.message;
      return openMenu();
    }
    if (!data.session) { L.err = '註冊成功，但需要先到信箱點確認信。若不想收信，請到 Supabase 關閉 Confirm email。'; return openMenu(); }
    sbUser = data.user; state.login = {};
    Object.keys(db.albums).forEach(k => db.dirty[k] = 1); // 第一次登入：把本機全部推上去
    if (recentSearchesAt) db.dirty[META_RS] = 1;
    Object.keys(db.deleted).forEach(k => db.dirty[k] = 1);
    save(); toast('✓ 已登入，開始同步'); openMenu(); await syncNow(); if ($('#sheet').classList.contains('show')) openMenu();
  };
}
function openManual() {
  state.current = null;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin:0 0 4px">手動新增</h2><div class="muted small">搜不到的唱片（獨立發行、實體 CD…）可以自己加</div>
    <form id="mform">
      <div class="field"><label>歌手 *</label><input name="artist" required></div>
      <div class="field"><label>專輯名稱 *</label><input name="title" required></div>
      <div class="field" style="display:flex;gap:10px">
        <div style="flex:1"><label>類型</label><select name="type"><option value="Album">專輯</option><option value="EP">EP</option><option value="Single">單曲</option></select></div>
        <div style="flex:1"><label>年份</label><input name="year" inputmode="numeric" maxlength="4"></div>
      </div>
      <div class="field"><label>加到</label><select name="status"><option value="heard">已聽過</option><option value="want">想聽</option></select></div>
      <div class="field"><label>封面圖片網址（選填）</label><input name="cover" type="url"></div>
      <div class="two"><button class="big-btn solid" type="submit">${I.plus} 加入</button></div>
    </form>`;
  showSheet();
  $('#mform').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const a = { id: 'm' + Date.now(), title: f.title.trim(), artist: f.artist.trim(), artistId: '', type: f.type, year: f.year, cover: f.cover, tracks: 0, manual: true };
    const k = albumKey(a);
    if (db.albums[k]) return toast('這張已經在清單裡了');
    seen.set(k, a); setStatus(k, f.status); closeSheet(true); toast('✓ 已加入');
  };
}
function exportData() {
  const blob = new Blob([JSON.stringify({ albums: db.albums, settings: db.settings }, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = u; a.download = `heard-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text()); let n = 0;
    Object.values(d.albums || {}).forEach(a => {
      const k = albumKey(a); if (db.albums[k]) return;
      db.albums[k] = { status: 'heard', ...a, updatedAt: Date.now() }; db.dirty[k] = 1; n++;
    });
    save(); scheduleSync(); closeSheet(true); toast(`匯入 ${n} 張新唱片`);
  } catch (err) { toast('檔案格式不正確'); }
  e.target.value = '';
};

/* ================= 事件 ================= */
document.addEventListener('click', async e => {
  const swRow = e.target.closest('.sw');
  if (swRow && !e.target.closest('.sw-del') && (swRow.dataset.justSwiped || swRow.classList.contains('open'))) { swRow.classList.remove('open'); return; }
  if (!swRow) closeSwipes();
  const rm = e.target.closest('[data-rmrecent]');
  if (rm) { e.stopPropagation(); recentSearches.splice(+rm.dataset.rmrecent, 1); saveRecentSearches(); return updateSearchBody(); }
  // 從搜尋結果或最近搜尋點開的，記到最近搜尋
  if (state.tab === 'search' && !state.view && e.target.closest('#sres') && (state.results || e.target.closest('[data-rs]'))) {
    const op = e.target.closest('[data-open]'), ar = e.target.closest('[data-name]');
    const onBtn = e.target.closest('[data-heard],[data-want],[data-arch]');
    if (op && !onBtn) { const a = findAlbum(op.dataset.open); if (a) { const { _tracks, ...clean } = a; addRecentSearch({ type: 'album', key: op.dataset.open, album: clean }); } }
    else if (ar && !op) addRecentSearch({ type: 'artist', name: ar.dataset.name, artistId: ar.dataset.artist, img: ar.querySelector('img')?.getAttribute('src') || '' });
  }
  const del = e.target.closest('[data-delartist]');
  if (del) return deleteArtist(del.dataset.delartist);
  const t = e.target.closest('[data-heard],[data-want],[data-arch],[data-open],[data-name],[data-tab],[data-f],[data-sort],[data-view],[data-act]');
  if (!t) return;
  const d = t.dataset;
  if (d.heard !== undefined) { e.stopPropagation(); return toggle(d.heard, 'heard'); }
  if (d.want !== undefined) { e.stopPropagation(); return toggle(d.want, 'want'); }
  if (d.arch !== undefined) { e.stopPropagation(); return toggle(d.arch, 'archived'); }
  if (d.open !== undefined) return openAlbum(d.open);
  if (d.name !== undefined) {
    if ($('#sheet').classList.contains('show')) hideSheet();
    state.view = { type: 'artist', id: d.artist || '', name: d.name }; window.scrollTo(0, 0); return render();
  }
  if (d.tab) {
    if (d.tab !== state.tab) { state.libFilter = null; state.libQ = ''; state.searchFocus = false; }
    else if (d.tab === 'search' && !state.view) { state.results = null; state.q = ''; }
    state.tab = d.tab; state.view = null; window.scrollTo(0, 0); return render();
  }
  if (d.f) {
    const v = d.v || null;
    if (d.f === 'lib') state.libFilter = v;
    else if (d.f === 'artist') { state.view.filter = v; }
    else if (d.f === 'search') {
      state.sf = v;
      const need = v === 'artist' ? 'artist' : 'album';
      if (state.results && state.resKind !== need && state.q) { render(); return doSearch(state.q); }
    }
    return render();
  }
  if (d.view) { db.settings.view ??= {}; db.settings.view[state.tab] = d.view; save(); return render(); }
  if (d.sort) { setSort(state.tab, d.sort); hideSheet(); window.scrollTo(0, 0); return render(); }
  switch (d.act) {
    case 'back': state.view = null; return render();
    case 'clear': state.results = null; state.q = ''; return render();
    case 'menu': return openMenu();
    case 'searchCancel': return endSearch();
    case 'clearRecent': recentSearches = []; saveRecentSearches(); return updateSearchBody();
    case 'archive': hideSheet(); state.view = { type: 'archive' }; window.scrollTo(0, 0); return render();
    case 'sortMenu': return openSortMenu();
    case 'sortFlip': { const c = sortOf(state.tab); db.settings.sort[state.tab] = { key: c.key, desc: !c.desc }; save(); return render(); }
    case 'manual': return openManual();
    case 'export': return exportData();
    case 'import': return $('#importFile').click();
    case 'spLogin': return spotifyLogin();
    case 'spLogout': spotifyLogout(); toast('已中斷 Spotify'); return openMenu();
    case 'syncNow': await syncNow(true); return openMenu();
    case 'logout': await sb.auth.signOut(); sbUser = null; toast('已登出（本機資料保留）'); return openMenu();
    case 'loginReset': state.login = {}; return openMenu();
  }
});
// 每次切回 App：同步資料，並重新抓 Spotify 最近播放
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNow(); if (spOn()) loadSpotifyHome(true); } });
$('#scrim').onclick = () => closeSheet();
// 面板打開時，在背景遮罩上滑動不會捲動底下的頁面
$('#scrim').addEventListener('touchmove', e => e.preventDefault(), { passive: false });
(() => { // 下滑關閉：拖曳時 1:1 跟手，放開時依距離或速度決定收回或彈回
  const s = $('#sheet'), scrim = $('#scrim');
  let y0 = null, dy = 0, dragging = false, lastY = 0, lastT = 0, v = 0;
  const reset = () => { s.style.transition = scrim.style.transition = ''; };
  s.addEventListener('touchstart', e => {
    if (e.touches.length > 1) { y0 = null; return; }
    y0 = (s.scrollTop <= 0 || e.target.closest('.grab')) ? e.touches[0].clientY : null;
    dy = 0; v = 0; dragging = false; lastY = y0; lastT = e.timeStamp;
  }, { passive: true });
  s.addEventListener('touchmove', e => {
    if (y0 === null) return;
    const y = e.touches[0].clientY;
    dy = y - y0;
    if (!dragging) {
      if (dy < 4) { if (dy < -4) y0 = null; return; }   // 往上滑＝捲動內容，不拖曳
      dragging = true;
      s.style.transition = scrim.style.transition = 'none';
    }
    e.preventDefault();
    const dt = e.timeStamp - lastT;
    if (dt > 0) v = 0.8 * ((y - lastY) / dt) + 0.2 * v;  // 平滑後的速度（px/ms）
    lastY = y; lastT = e.timeStamp;
    const d = Math.max(0, dy);
    s.style.transform = `translateY(${d}px)`;
    scrim.style.opacity = String(Math.max(0, 1 - d / (s.offsetHeight || 1)));
  }, { passive: false });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    if (!dragging) return;
    dragging = false;
    reset();
    const close = dy > Math.min(160, s.offsetHeight * 0.3) || v > 0.45;
    // 同一個畫格內移除 inline 樣式，讓動畫從手指放開的位置接續，不會先彈回再收
    s.style.transform = ''; scrim.style.opacity = '';
    if (close) closeSheet();
  };
  s.addEventListener('touchend', end);
  s.addEventListener('touchcancel', end);
})();

/* ================= 快速標記：網址加 ?np 直接跳出「正在播放」的專輯（給 iPhone 捷徑／背面輕點用） ================= */
async function quickNowPlaying() {
  if (!CFG.SPOTIFY_CLIENT_ID) return;
  if (!spOn()) {
    state.current = null;
    $('#sheet').innerHTML = `<div class="grab"></div><div style="text-align:center;padding:10px 0 4px">
      <h2 style="margin:0 0 6px">先連結 Spotify</h2>
      <div class="muted small">這個瀏覽器還沒連結 Spotify，連結一次之後就能一鍵標記正在播放的專輯</div>
      <div class="two"><button class="big-btn solid" data-act="spLogin">連結 Spotify</button></div></div>`;
    return showSheet();
  }
  $('#sheet').innerHTML = '<div class="grab"></div><div class="spinner"></div>'; showSheet();
  try {
    const v = await spNowPlaying();
    state.sp.np = v;
    if (!v) { hideSheet(); render(); return toast('Spotify 目前沒有在播放'); }
    state.npKey = albumKey(v.album);
    openAlbum(state.npKey);
  } catch (e) { hideSheet(); render(); toast(e.message); }
}

/* ================= 啟動 ================= */
(async () => {
  save();
  await spotifyCallback();
  const wantNp = new URLSearchParams(location.search).has('np');
  if (wantNp) history.replaceState(null, '', spRedirect());
  render();
  initSync();
  if (wantNp) quickNowPlaying();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
