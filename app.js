/* SHeard · 專輯書籤 v2
 * 資料：本機 localStorage 為主，登入後與 Supabase 雙向同步（新的修改勝出）
 * 資料來源：全部取自 Spotify（搜尋、演出者作品、曲目、最近播放），一律手動標記
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
// 用「演出者名＋專輯名」當作唯一鍵，讓 Spotify、手動新增、以及舊版資料的同一張專輯對得起來
// 單曲／EP 另外加上「|s」：同名的專輯和單曲（例如專輯「空中飛人」和單曲「空中飛人」）是兩張不同的專輯
const isSingleType = t => t === 'Single' || t === 'EP';
const albumKey = a => `${norm(a.artist)}|${norm(a.title)}${isSingleType(a.type) ? '|s' : ''}`;
// 舊資料的單曲沒有「|s」，搬到新的鍵（雲端也會跟著更新）
function migrateKeys() {
  const now = Date.now(); let n = 0;
  Object.keys(db.albums).forEach(k => {
    const a = db.albums[k]; if (!a || !a.artist || !a.title) return;
    const nk = albumKey(a); if (nk === k) return;
    const cur = db.albums[nk];
    if (!cur || (cur.updatedAt || 0) < (a.updatedAt || 0)) { db.albums[nk] = { ...a, updatedAt: now }; db.dirty[nk] = 1; }
    delete db.albums[k]; db.deleted[k] = now; db.dirty[k] = 1; n++;
  });
  if (n) save();
  return n;
}

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
// 想聽功能已移除：把舊的想聽資料刪掉（會同步刪除雲端）
function purgeWant() {
  const now = Date.now(); let n = 0;
  Object.keys(db.albums).forEach(k => { if (db.albums[k].status === 'want') { delete db.albums[k]; db.deleted[k] = now; db.dirty[k] = 1; n++; } });
  return n;
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

/* 設定狀態：'heard' | 'archived' | null(移除) */
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
const statusName = s => ({ heard: '已聽過', archived: '封存' })[s] || s;
// 「完成」：已聽過或封存，進度條都算進去
const isDone = s => s === 'heard' || s === 'archived';
async function toggle(k, status) {
  const was = statusOf(k);
  const a = db.albums[k];
  // 取消標記，或把「已聽過」改成其他狀態時，先確認
  if (a && (was === status || was === 'heard')) {
    const removing = was === status;
    const extra = removing && a.manual ? '<br><b>這是手動新增的專輯，取消後整筆資料會刪除。</b>' : '';
    const ok = await ask({
      title: removing ? `取消「${statusName(was)}」？` : `從「已聽過」改成「${statusName(status)}」？`,
      msg: `<b>${esc(a.title)}</b><br><span class="muted">${esc(a.artist)}</span>${extra}`,
      ok: removing ? `取消${statusName(was)}` : `改成${statusName(status)}`
    });
    if (!ok) return;
  }
  if (setStatus(k, was === status ? null : status) === false) return;
  toast(was === status ? ({ heard: '已取消「已聽過」', archived: '已取消封存' })[status]
    : ({ heard: '✓ 已聽過', archived: '已封存' })[status]);
  if (state.current) renderSheet();
  render();
}
function touch(k) { db.albums[k].updatedAt = Date.now(); db.dirty[k] = 1; save(); scheduleSync(); }

/* ================= Spotify 目錄（搜尋／演出者作品／曲目） ================= */
// 快取：記憶體＋存在手機上（重開 App 也不用重抓），大幅減少對 Spotify 的請求次數
const cache = new Map();
const PC_KEY = 'heard.spCache', PC_MAX = 150;
const pcache = (() => { try { return JSON.parse(localStorage.getItem(PC_KEY)) || {}; } catch (e) { return {}; } })();
const ttlFor = path => path.startsWith('/search') ? 864e5            // 搜尋：1 天
  : /^\/artists\/[^/]+\/albums/.test(path) ? 7 * 864e5              // 演出者作品：7 天
  : /^\/(artists|albums)\//.test(path) ? 30 * 864e5 : 0;            // 演出者資料、專輯曲目：30 天
const isEmptyResp = j => !j || (Array.isArray(j.items) && !j.items.length) || (j.albums && !(j.albums.items || []).length) || (j.artists && !j.name && !(j.artists.items || []).length);
Object.keys(pcache).forEach(k => { if (isEmptyResp(pcache[k]?.j)) delete pcache[k]; });
let pcSaveT = null;
function pcSave() {
  clearTimeout(pcSaveT);
  pcSaveT = setTimeout(() => {
    const keys = Object.keys(pcache);
    if (keys.length > PC_MAX) keys.sort((a, b) => pcache[a].t - pcache[b].t).slice(0, keys.length - PC_MAX).forEach(k => delete pcache[k]);
    try { localStorage.setItem(PC_KEY, JSON.stringify(pcache)); }
    catch (e) { Object.keys(pcache).sort((a, b) => pcache[a].t - pcache[b].t).slice(0, Math.ceil(Object.keys(pcache).length / 2)).forEach(k => delete pcache[k]); try { localStorage.setItem(PC_KEY, JSON.stringify(pcache)); } catch (e2) {} }
  }, 500);
}
// 下拉重新整理時：這些演出者（id 或名字）的作品不用快取，直接向 Spotify 重抓
const freshKeys = new Set();
const forceFresh = path => [...freshKeys].some(k => path.includes(k));
async function spCached(path) {
  const fresh = freshKeys.size && forceFresh(path);
  if (!fresh && cache.has(path)) return cache.get(path);
  const ttl = ttlFor(path), hit = pcache[path];
  if (!fresh && ttl && hit && Date.now() - hit.t < ttl) { cache.set(path, hit.j); return hit.j; }
  const j = await sp(path); cache.set(path, j);
  if (ttl && !isEmptyResp(j)) { pcache[path] = { t: Date.now(), j }; pcSave(); }
  return j;
}
const isSpId = id => /^[0-9A-Za-z]{22}$/.test(id || '');
const dedupe = list => { const m = new Map(); list.forEach(a => { const k = albumKey(a); if (!m.has(k)) m.set(k, a); }); return [...m.values()]; };
// 開發模式每次最多 10 筆，一次抓 3 頁（30 筆）
// Spotify 搜尋：先帶 market，失敗就不帶再試一次（開發模式有時會拒絕某些參數）
async function spSearch(type, q, offset = 0) {
  const enc = encodeURIComponent(q);
  // 帶 market 的搜尋會被開發模式拒絕（403），一律不帶
  return spCached(offset ? `/search?type=${type}&limit=10&offset=${offset}&q=${enc}` : `/search?type=${type}&limit=10&q=${enc}`);
}
async function searchAlbums(q) {
  const pages = await Promise.all([0].map(o => spSearch('album', q, o).catch(e => ({ err: e }))));
  if (pages.every(p => !p || p.err)) throw pages[0]?.err || new Error('搜尋失敗');
  return dedupe(pages.flatMap(p => p?.albums?.items || []).filter(Boolean).map(fromSpotify)).filter(notComp);
}
async function searchArtists(q) {
  const enc = encodeURIComponent(q);
  const pages = await Promise.all([0, 10].map(o => spCached(`/search?type=artist&limit=10&offset=${o}&q=${enc}`).catch(() => null)));
  if (pages.every(p => !p)) throw new Error('搜尋失敗');
  const m = new Map(); pages.flatMap(p => p?.artists?.items || []).filter(Boolean).forEach(x => m.set(x.id, x));
  return [...m.values()];
}
// 演出者頭貼：直接用 Spotify 上的演出者照片（取中等尺寸約 320px）
async function artistImage(id, name) {
  if (!isSpId(id)) return '';
  let im = [];
  try { im = (await spCached('/artists/' + id))?.images || []; }
  catch (e) {
    if (!name) throw e;           // 演出者端點被擋時，改從搜尋結果拿照片
    const j = await spSearch('artist', name);
    im = (j?.artists?.items || []).find(x => x?.id === id)?.images || [];
  }
  return (im.find(x => (x.width || 0) >= 200 && (x.width || 0) <= 400) || im[0] || {}).url || '';
}
// 演出者：照 Spotify 的相關度，名稱完全相同的排最前（不再用名稱過濾，中文搜尋英文名的演出者也找得到）
async function searchArtistsTop(q) {
  const j = await spSearch('artist', q);
  const list = (j?.artists?.items || []).filter(Boolean);
  const nq = norm(q);
  return list.sort((a, b) => (norm(b.name) === nq) - (norm(a.name) === nq)).slice(0, 5);
}
const isFresh = path => !(freshKeys.size && forceFresh(path)) && (cache.has(path) || (pcache[path] && Date.now() - pcache[path].t < ttlFor(path)));
let discBusy = 0;
// 抓演出者在 Spotify 上的全部作品（專輯、單曲和迷你專輯；不含參與的專輯與合輯）
// 開發模式每頁最多 10 筆，逐頁翻；每頁都存在手機上，中途被限流也會保留已抓到的，恢復後從斷掉的地方接著抓
// 回傳陣列；沒抓完時陣列帶 incomplete=true 與 err
// 先用演出者作品端點；被擋或失敗時，改用搜尋 artist:"名字" 找出他的作品（只留演出者裡有他的，等於不含參與的專輯）
let discStats = [];   // 診斷用：最近幾次抓演出者作品的統計
function logDisc(st, raw, r, err) {
  const byKey = new Map(); raw.forEach(al => { const a = fromSpotify(al), k = albumKey(a); (byKey.get(k) || byKey.set(k, []).get(k)).push(al.name + '/' + al.album_type); });
  discStats = [{ ...st, src: r.src, raw: raw.length, shown: r.length, err: err ? String(err.message || err).slice(0, 80) : '',
    merged: [...byKey.values()].filter(v => v.length > 1).slice(0, 15) }, ...discStats].slice(0, 4);
  return r;
}
async function artistAlbums(id, name, onPage, groups = 'album,single') {
  const out = [];
  const st = { name, at: new Date().toLocaleTimeString('zh-TW', { hour12: false }), total: null, pages: 0, api: 0 };
  const finish = (err) => {
    const r = dedupe(out.map(fromSpotify)).sort((a, b) => (b.date || b.year || '').localeCompare(a.date || a.year || ''));
    if (err) { r.incomplete = true; r.err = err.message || String(err); }
    return r;
  };
  discBusy++;
  try {
    let viaApi = !cooldownLeft('artists'), apiErr = null;
    if (viaApi) {
      let mk = '&market=from_token';
      for (let off = 0; off < 400; off += 10) {
        const path = `/artists/${id}/albums?include_groups=${groups}${mk}&limit=10&offset=${off}`;
        const net = !isFresh(path);
        let j;
        try { j = await spCached(path); }
        catch (e) {
          if (off === 0 && mk && !/限制|上限|拒絕|過期|尚未/.test(e.message)) { mk = ''; off -= 10; continue; }
          apiErr = e; break;
        }
        const items = (j?.items || []).filter(Boolean);
        if (off === 0 && mk && !items.length) { mk = ''; off -= 10; continue; }
        out.push(...items); st.pages++; st.api += items.length; if (off === 0) st.total = j?.total ?? null;
        if (!j?.next || !items.length) break;
        if (onPage) onPage(finish());
        if (net) await sleep(350);
      }
      if (!apiErr && out.length) return logDisc(st, out, Object.assign(finish(), { src: 'api' }), apiErr);   // 完整清單；回傳空的才改用搜尋
    }
    if (!name) { if (apiErr && !out.length) throw apiErr; return finish(apiErr); }
    // 備援：搜尋。演出者作品端點被擋時改用搜尋拼出完整作品：
    // 1. 專輯搜尋（名字、artist:名字）→ 專輯和 EP
    // 2. 歌曲搜尋（artist:名字、名字）→ 從每首歌所屬的專輯補齊單曲（單曲在專輯搜尋裡常排很後面或搜不到）
    // 只留演出者有這位演出者的，並排除合輯；連續 4 頁都沒有他的作品才停
    let searchErr = null;
    const passes = [['album', name, 400], ['album', `artist:${name}`, 400], ['track', `artist:${name}`, 500], ['track', name, 300]];
    for (const [type, q, cap] of passes) {
      let miss = 0;
      for (let off = 0; off < cap; off += 10) {
        const enc = encodeURIComponent(q);
        const path = off ? `/search?type=${type}&limit=10&offset=${off}&q=${enc}` : `/search?type=${type}&limit=10&q=${enc}`;
        const net = !isFresh(path);
        let j;
        try { j = await spCached(path); }
        catch (e) { searchErr = e; break; }
        const box = type === 'album' ? j?.albums : j?.tracks;
        const items = (box?.items || []).filter(Boolean);
        const albums = type === 'album' ? items : items.map(t => t.album).filter(Boolean);
        const mine = albums.filter(al => al.album_type !== 'compilation' && (al.artists || []).some(x => x.id === id));
        const seen = new Set(out.map(x => x.id)), fresh = mine.filter(al => !seen.has(al.id));
        out.push(...fresh);
        miss = mine.length ? 0 : miss + 1;
        if (onPage && fresh.length) onPage(finish());
        if (!box?.next || !items.length || miss >= 4) break;
        if (net) await sleep(300);
      }
      if (searchErr && /限制|上限/.test(searchErr.message)) break;
    }
    if (!out.length && (searchErr || apiErr)) throw searchErr || apiErr;
    if (searchErr && /限制|上限/.test(searchErr.message)) return finish(searchErr);
    return logDisc(st, out, Object.assign(finish(), { src: 'search' }), apiErr || searchErr);
  } finally { discBusy--; }
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
  const j = await spCached(`/search?type=album&limit=10&q=${q}`);
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
  return items.map(x => ({ n: x.track_number, name: x.name, ms: x.duration_ms, id: x.id }));
}

/* ================= Spotify（PKCE，免後端） ================= */
const SP_KEY = 'heard.spotify';
const SP_SCOPES = 'user-read-currently-playing user-read-recently-played user-library-read playlist-read-private playlist-read-collaborative';
const hasLibScope = () => /user-library-read/.test(spTok?.scope || '');
// 缺少的權限（收藏與歌單都要）：缺了就在設定頁顯示「重新連結」
const missingScopes = () => SP_SCOPES.split(' ').filter(x => !(spTok?.scope || '').split(' ').includes(x));
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
    code_challenge_method: 'S256', code_challenge: challenge, scope: SP_SCOPES, state: st,
    show_dialog: 'true'          // 一定顯示授權畫面，新增的權限（例如歌單）才會被同意
  });
}
async function spTokenReq(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.SPOTIFY_CLIENT_ID, ...body })
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || res.status);
  spTok = { access: j.access_token, refresh: j.refresh_token || spTok?.refresh, exp: Date.now() + (j.expires_in - 60) * 1000, scope: j.scope ?? spTok?.scope ?? '' };
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
// 診斷紀錄：最近 20 次 Spotify 請求的路徑、狀態、筆數、錯誤訊息（只存在這台裝置，方便找問題）
const spLog = (() => { try { return JSON.parse(localStorage.getItem('heard.spLog')) || []; } catch (e) { return []; } })();
function logSp(entry) {
  spLog.unshift({ t: Date.now(), ...entry }); spLog.length = Math.min(spLog.length, 20);
  try { localStorage.setItem('heard.spLog', JSON.stringify(spLog)); } catch (e) {}
}
function countOf(j) {
  if (!j) return '無內容';
  if (Array.isArray(j)) return `已收藏 ${j.filter(Boolean).length}/${j.length}`;
  const parts = [];
  if (j.albums) parts.push(`專輯 ${j.albums.items?.length ?? 0}/${j.albums.total ?? '?'}`);
  if (j.artists && !j.name) parts.push(`演出者 ${j.artists.items?.length ?? 0}/${j.artists.total ?? '?'}`);
  if (Array.isArray(j.items)) parts.push(`項目 ${j.items.length}/${j.total ?? '?'}`);
  if (j.name) parts.push(j.name);
  return parts.join('、') || '有回應';
}
async function sp(path, retry = true) {
  try { const j = await spRaw(path, retry); logSp({ path, ok: true, info: countOf(j) }); return j; }
  catch (e) { logSp({ path, ok: false, info: e.message }); throw e; }
}
// 被 Spotify 限流時的冷卻：記在手機上（重開 App 不會重置），連續被擋會逐次加長：30 秒 → 2 分 → 8 分 → 30 分 → 1 小時
const COOL_KEY = 'heard.spCool';
// Spotify 會只擋某一類端點（例如演出者作品被擋、搜尋和最近播放正常），所以冷卻分開記：artists / search / me / albums
const bucketOf = path => (path.split(/[/?]/)[1] || '');
const spCool = (() => { try { const c = JSON.parse(localStorage.getItem(COOL_KEY)) || {}; return c.until !== undefined ? {} : c; } catch (e) { return {}; } })();
const saveCool = () => { try { localStorage.setItem(COOL_KEY, JSON.stringify(spCool)); } catch (e) {} };
const cooldownLeft = b => {
  const left = x => Math.max(0, Math.ceil(((x?.until || 0) - Date.now()) / 1000));
  return b ? left(spCool[b]) : Math.max(0, ...Object.values(spCool).map(left));
};
const fmtWait = sec => sec >= 60 ? `${Math.ceil(sec / 60)} 分鐘` : `${sec} 秒`;
async function spRaw(path, retry = true) {
  if (!spTok) throw new Error('尚未連結 Spotify');
  const bk = bucketOf(path), cb = spCool[bk] ||= { until: 0, strikes: 0 };
  if (cooldownLeft(bk)) throw new Error(`Spotify 暫時限制請求，約 ${fmtWait(cooldownLeft(bk))}後自動恢復`);
  if (!spTok.access || Date.now() > spTok.exp) {
    try { await spTokenReq({ grant_type: 'refresh_token', refresh_token: spTok.refresh }); }
    catch (e) { spotifyLogout(); render(); throw new Error('Spotify 登入已過期，請重新連結'); }
  }
  // 個人資料（最近播放、正在播放）每次都要最新的，不讓瀏覽器用快取
  const res = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + spTok.access }, cache: path.startsWith('/me') ? 'no-store' : 'default' });
  if (res.ok && cb.strikes) { cb.strikes = 0; saveCool(); }
  if (res.status === 204) return null;
  if (res.status === 401 && retry) { spTok.exp = 0; return spRaw(path, false); }
  if (res.status === 403) throw new Error('Spotify 拒絕存取：請確認你的帳號已加入開發者後台的 User Management，且 App 擁有者有 Premium');
  if (res.status === 429) {
    let reason = ''; try { reason = (await res.json())?.reason || ''; } catch (e) {}
    const ra = +(res.headers.get('Retry-After') || 0);
    cb.strikes++;
    const backoff = Math.min(3600, 30 * Math.pow(4, cb.strikes - 1));
    const wait = Math.max(ra, backoff, reason === 'QUOTA_EXCEEDED' ? 600 : 0);
    cb.until = Date.now() + wait * 1000; saveCool();
    throw new Error((reason === 'QUOTA_EXCEEDED' ? '已達 Spotify 用量上限' : 'Spotify 暫時限制請求') + `，約 ${fmtWait(wait)}後自動恢復（${bk}，第 ${cb.strikes} 次）`);
  }
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json())?.error?.message || ''; } catch (e) {}
    throw new Error('Spotify 錯誤 ' + res.status + (msg ? '：' + msg : ''));
  }
  return res.json();
}
async function spNowPlaying() {
  const j = await sp('/me/player/currently-playing');
  if (!j?.item?.album) return null;
  return { album: remember([fromSpotify(j.item.album)])[0], track: j.item.name, playing: j.is_playing };
}
async function spRecent() {
  // 正在播放的專輯也算進最近播放（Spotify 要等歌播完才會寫進最近播放紀錄），放在最前面
  const [j, now] = await Promise.all([sp('/me/player/recently-played?limit=50'), sp('/me/player/currently-playing').catch(() => null)]);
  const m = new Map();
  const cur = now?.item?.album && notComp(fromSpotify(now.item.album)) ? fromSpotify(now.item.album) : null;
  if (cur) m.set(albumKey(cur), cur);
  (j?.items || []).forEach(it => { const a = fromSpotify(it.track.album); const k = albumKey(a); if (!m.has(k)) m.set(k, a); });
  return remember([...m.values()].filter(notComp).slice(0, 10));   // 首頁只放最新 10 張
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
        if (r.key === META_FA) {
          const ts = Number(r.updated_at);
          if (ts > followedAt) { applyRemoteFollowed(r.data?.items, ts); delete db.dirty[META_FA]; }
          else if (ts === followedAt) delete db.dirty[META_FA];
          return;
        }
        if (r.key.startsWith('__meta:')) return;
        const k = r.key, localTs = db.albums[k]?.updatedAt ?? db.deleted[k] ?? 0, ts = Number(r.updated_at);
        if (ts > localTs) {
          if (r.deleted) { delete db.albums[k]; db.deleted[k] = ts; delete db.dirty[k]; }
          else if (r.data?.status === 'want') { delete db.albums[k]; db.deleted[k] = Date.now(); db.dirty[k] = 1; }
          else { db.albums[k] = r.data; delete db.deleted[k]; delete db.dirty[k]; }
        } else if (ts === localTs) delete db.dirty[k];
      });
      if (data.length < 1000) break;
    }
    if (migrateKeys()) metaChanged = true;   // 其他裝置用舊版存的單曲，搬到新的鍵
    // 2. 推上本機有改過的
    const rows = Object.keys(db.dirty).map(k => k === META_RS
      ? { user_id: sbUser.id, key: k, data: { items: recentSearches }, deleted: false, updated_at: recentSearchesAt || Date.now() }
      : k === META_FA
      ? { user_id: sbUser.id, key: k, data: { items: followed }, deleted: false, updated_at: followedAt || Date.now() }
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
  libFilter: (() => { try { return localStorage.getItem('heard.libFilter') || null; } catch (e) { return null; } })(), archFilter: null, archQ: '', artQ: '', sf: null, resKind: null, libQ: '', current: null, sp: {}, syncErr: '', login: {}
};
const seen = new Map();
function remember(list) { list.forEach(a => { const k = albumKey(a); const old = seen.get(k); seen.set(k, old ? { ...old, ...a, _tracks: old._tracks } : a); }); return list; }
const findAlbum = k => db.albums[k] || seen.get(k);
const typeLabel = t => ({ Album: '專輯', EP: 'EP', Single: '單曲', Compilation: '合輯' })[t] || t;
// 跟 Spotify 一樣的發行類型分組
// 整個 App 都不算「參與的專輯」和「合輯」（使用者規則）
const RELEASES = [['Album', '專輯'], ['SingleEP', '單曲和迷你專輯']];
const notComp = a => a && a.type !== 'Compilation';
const myAlbums = () => Object.values(db.albums).filter(notComp);
const inGroup = (a, g) => !g ? true : g === 'Album' ? a.type === 'Album' : g === 'SingleEP' ? (a.type === 'Single' || a.type === 'EP') : g === 'Compilation' ? a.type === 'Compilation' : true;
// Spotify 式單選標籤：選了一個就只留「✕＋已選的」，再點一次或按 ✕ 取消回到全部
function chipBar(scope, opts, sel, style = '') {
  const on = opts.find(([v]) => v === sel);
  return `<div class="chips" style="${style}">${on
    ? `<button class="chip x" data-f="${scope}" data-v="" aria-label="清除篩選">✕</button><button class="chip on" data-f="${scope}" data-v="">${on[1]}</button>`
    : opts.map(([v, l]) => `<button class="chip" data-f="${scope}" data-v="${v}">${l}</button>`).join('')}</div>`;
}

const I = {
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9 17.5 19 6.5"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>',
  markOn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  archiveOn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.2"/><path d="M5 9v10.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V9z"/><path d="M10 13.5h4" stroke="#fff"/></svg>',
  archive: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.2"/><path d="M5 9v10.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V9M10 13.5h4"/></svg>',
  sort: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  flip: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>',
  v_grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  v_small: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="9.5" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><rect x="16" y="9.5" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><rect x="9.5" y="16" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/></svg>',
  v_list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="4" width="5" height="5" rx="1"/><rect x="3" y="15" width="5" height="5" rx="1"/><path d="M11 5.5h10M11 8h6M11 16.5h10M11 19h6"/></svg>',
  savedOn: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#121212" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m15 5-7 7 7 7"/></svg>'
};
const gearBtn = () => `<button class="icon-btn" data-act="menu" aria-label="設定">${I.gear}${syncOn() ? `<span id="syncDot" class="dot ${syncing ? 'busy' : (sbUser && !state.syncErr ? '' : 'off')}"></span>` : ''}</button>`;

/* ================= 畫面 ================= */
// 回到上一頁時恢復原本的捲動位置；返回手勢拖動時，底下要顯示上一頁的畫面
let baseY = 0, baseSnap = null, viewShown = false;
const APP_VER = 'v76';
const pageY = () => Math.max(window.scrollY || 0, document.scrollingElement?.scrollTop || 0, document.body.scrollTop || 0);
function onPageScroll() {
  const y = pageY();
  if (!state.view) baseY = y;
  document.documentElement.classList.toggle('scrolled', y > 4);
  // 搜尋欄固定在頂部時，下方顯示漸層遮罩
  const sr = (!state.view || state.view.type === 'archive') && document.querySelector('#app .search-row');
  if (sr) {
    const stickTop = parseFloat(getComputedStyle(sr).top) || 0;
    sr.classList.toggle('stuck', y > 0 && sr.getBoundingClientRect().top <= stickTop + 0.5);
  }
  // 頁面標題往上推出畫面時淡出
  const hd = (!state.view || state.view.type === 'archive') && document.querySelector('#app > .home-head > header.top, #app > header.top');
  if (hd) {
    const bb = $('#app > .backbar');
    const r = hd.getBoundingClientRect(), topLine = bb ? bb.getBoundingClientRect().bottom : parseFloat(getComputedStyle($('#app')).paddingTop) || 0;
    const p = Math.min(1, Math.max(0, (topLine - r.top) / Math.max(1, r.height)));
    hd.style.opacity = p ? String(1 - p) : '';
  }
}
// iPhone 主畫面 App 有時不會在 window 觸發 scroll，所以多種方式一起偵測
addEventListener('scroll', onPageScroll, { passive: true });
document.addEventListener('scroll', onPageScroll, { passive: true, capture: true });
document.addEventListener('touchmove', () => requestAnimationFrame(onPageScroll), { passive: true });
document.addEventListener('touchend', () => { onPageScroll(); setTimeout(onPageScroll, 300); setTimeout(onPageScroll, 1200); }, { passive: true });
setInterval(onPageScroll, 500);
function render() {
  if (state.view && !viewShown) baseSnap = { html: $('#app').innerHTML, cls: $('#app').className, y: baseY };
  viewShown = !!state.view;
  $('#app').classList.toggle('search-mode', state.tab === 'search' && !state.view && !!state.searchFocus);
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const app = $('#app');
  if (state.view?.type === 'artist') return renderArtist(app);
  if (state.view?.type === 'archive') return renderArchive(app);
  ({ search: renderSearch, heard: renderLib, artists: renderArtists })[state.tab](app);
}

function albumCard(a, no) {
  const k = albumKey(a), s = statusOf(k);
  return `<div class="card${s === 'archived' ? ' is-arch' : ''}" data-open="${esc(k)}">
    <div class="cover">
      ${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : '<div class="ph">♪</div>'}
      ${a.type !== 'Album' ? `<span class="badge">${typeLabel(a.type)}</span>` : ''}
      <div class="acts">
        ${s !== 'heard' ? `<button class="mini ${s === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}" aria-label="封存">${I.archive}</button>` : ''}
        <button class="mini ${s === 'heard' ? 'heard' : ''}" data-heard="${esc(k)}" aria-label="已聽過">${s === 'heard' ? I.check : I.check}</button>
      </div>
    </div>
    <div class="t">${no ? `<span class="no">#${no}</span>` : ''}${esc(a.title)}</div>
    <div class="a">${s === 'heard' ? '<span class="lbl-w"><span class="lbl heard">✓ 已聽過</span> · </span>' : s === 'archived' ? '<span class="lbl-w"><span class="lbl arch">已封存</span> · </span>' : ''}${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
  </div>`;
}

/* 列表式的一列 */
function albumRow(a, no) {
  const k = albumKey(a), s = statusOf(k);
  return `<div class="arow${s === 'archived' ? ' is-arch' : ''}" data-open="${esc(k)}">
    ${no ? `<span class="arow-no">${no}</span>` : ''}
    <div class="arow-cover">${a.cover ? `<img loading="lazy" src="${esc(a.cover)}" alt="">` : '<div class="ph" style="font-size:20px">♪</div>'}</div>
    <div class="arow-main">
      <div class="arow-t">${esc(a.title)}</div>
      <div class="arow-a">${esc(a.artist)}</div>
      <div class="arow-m">${typeLabel(a.type)}${a.year ? ' · ' + a.year : ''}</div>
    </div>
    <div class="arow-acts">
        ${s !== 'heard' ? `<button class="mini ${s === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}" aria-label="封存">${I.archive}</button>` : ''}
      <button class="mini ${s === 'heard' ? 'heard' : ''}" data-heard="${esc(k)}" aria-label="已聽過">${s === 'heard' ? I.check : I.check}</button>
    </div>
  </div>`;
}
const VIEWS = [['grid', '大圖示'], ['small', '小圖示'], ['list', '列表']];
function viewOf(st) { db.settings.view ??= {}; return db.settings.view[st] || 'list'; }
const viewBtn = (st, extra = '') => { const l = viewOf(st) === 'list'; return `<button class="icon-btn" data-act="viewToggle" data-st="${st}" aria-label="${l ? '圖示' : '列表'}"${extra}>${l ? I.v_grid : I.v_list}</button>`; };

/* ---------- 首頁（搜尋＋最近播放） ---------- */
// 搜尋結果區塊（只更新這塊，打字時輸入框不會被重畫、鍵盤也不會收起）
function searchBodyHTML() {
  const r = state.results;
  if (state.searchFocus && !r && !state.q) return recentSearchHTML();
  if (!r) return state.loading ? '<div class="spinner"></div>' : homeHTML();
  const artists = r.artists || [], albums = remember(r.albums || []);
  if (!artists.length && !albums.length) return state.loading ? '<div class="spinner"></div>'
    : r.err ? `<div class="empty">搜尋失敗<br><span class="small">${esc(r.err)}</span></div>` : '<div class="empty">找不到結果</div>';
  const img = x => x.images?.[x.images.length - 1]?.url || x.images?.[0]?.url || '';
  const row = a => sRowAlbum(a, albumKey(a)) + albumActs(albumKey(a)) + '</div>';
  const disc = remember(r.disc || []);
  const discKeys = new Set(disc.map(albumKey));
  const top = artists[0];
  // 跟 Spotify 一樣：最相關的演出者在最上面；接著列出他的全部作品，再來是其他符合的專輯與演出者
  const discHTML = !top ? '' : r.discLoading ? '<div class="spinner sm"></div>'
    : disc.length ? RELEASES.map(([g, l]) => {
        const list = disc.filter(a => inGroup(a, g));
        return list.length ? `<div class="s-sub">${l}</div>${list.map(row).join('')}` : '';
      }).join('') : '';
  const others = albums.filter(a => !discKeys.has(albumKey(a)));
  return `<div class="slist" style="margin-top:6px">
    ${top ? sRowArtist(top.name, top.id, img(top)) + '</div>' : ''}
    ${discHTML}
    ${others.length ? `${disc.length ? '<div class="s-sub">其他專輯</div>' : ''}${others.map(row).join('')}` : ''}
    ${artists.slice(1, 4).length ? `<div class="s-sub">其他演出者</div>${artists.slice(1, 4).map(x => sRowArtist(x.name, x.id, img(x)) + '</div>').join('')}` : ''}
  </div>`;
}
/* ---------- 最近搜尋（像 Spotify：記錄從搜尋結果點開的專輯／演出者，存在這台裝置） ---------- */
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
// 加入的演出者：不用標記專輯也能出現在演出者列表；跨裝置同步（key = META_FA）
const FA_KEY = 'heard.followed', FA_AT = 'heard.followedAt', META_FA = '__meta:followedArtists';
let followed = (() => { try { return JSON.parse(localStorage.getItem(FA_KEY)) || []; } catch (e) { return []; } })();
let followedAt = +(localStorage.getItem(FA_AT) || 0);
const isFollowed = name => followed.some(x => norm(x.name) === norm(name));
function saveFollowed() {
  followedAt = Date.now();
  try { localStorage.setItem(FA_KEY, JSON.stringify(followed)); localStorage.setItem(FA_AT, String(followedAt)); } catch (e) {}
  db.dirty[META_FA] = 1; save(); scheduleSync();
}
function applyRemoteFollowed(items, ts) {
  followed = Array.isArray(items) ? items : []; followedAt = ts;
  try { localStorage.setItem(FA_KEY, JSON.stringify(followed)); localStorage.setItem(FA_AT, String(ts)); } catch (e) {}
}
function setFollow(name, id, on) {
  followed = followed.filter(x => norm(x.name) !== norm(name));
  if (on) followed.unshift({ name, id: id || '', at: Date.now() });
  saveFollowed();
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
    <div class="srow-txt"><div class="srow-t">${esc(a.title)}</div><div class="srow-s">${s === 'heard' ? '<span class="lbl heard">已聽過</span> • ' : s === 'archived' ? '<span class="lbl arch">已封存</span> • ' : ''}${typeLabel(a.type)} • ${esc(a.artist)}</div></div>`;
}
function sRowArtist(name, id, img, extra = '') {
  return `<div class="srow" data-artist="${esc(id || '')}" data-name="${esc(name)}"${extra}>
    <div class="srow-img round">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<span>${esc(name[0])}</span>`}</div>
    <div class="srow-txt"><div class="srow-t">${esc(name)}</div><div class="srow-s">演出者</div></div>`;
}
const albumActs = k => { const s = statusOf(k); return `<div class="srow-acts">
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
    searchT = setTimeout(() => doSearch(q), 700);
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
  if (scrollY >= h - 1) {                // 已經往下捲、搜尋欄固定在頂部：直接切換，不做位移動畫
    app.classList.add('search-mode'); row.classList.add('focus');
    if (!state.q) res.innerHTML = searchBodyHTML();
    window.scrollTo(0, 0); return;
  }
  if (scrollY > 0) window.scrollTo(0, 0);
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
  if (scrollY > 0) window.scrollTo(0, 0);
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
      <b>連結 Spotify</b><div class="muted small" style="margin:4px 0 12px">搜尋、演出者作品和最近播放都來自 Spotify，連結後才能使用</div>
      <button class="btn primary" data-act="spLogin">連結 Spotify</button></div>`;
  const s = state.sp;
  const sec = (title, inner, extra = '') => `<div class="section-h"><span>${title}</span>${extra}</div>${inner}`;
  const recent = s.recent === undefined ? '<div class="spinner sm"></div>'
    : s.recent.filter(a => inGroup(a, state.sf)).length ? `<div class="grid">${s.recent.filter(a => inGroup(a, state.sf)).map(a => albumCard(a)).join('')}</div>` : '<div class="muted small">沒有最近播放紀錄</div>';
  return `${s.err ? `<div class="panel err">${esc(s.err)}</div>` : ''}
    ${sec('最近播放的專輯', recent)}`;
}

let spLoading = null;
function loadSpotifyHome(force) {
  if (spLoading) return spLoading;          // 已經在抓：等同一次的結果
  const s = state.sp;
  if (!force && s.loadedAt && Date.now() - s.loadedAt < 60000) return Promise.resolve();
  return spLoading = loadSpotifyHome_(s).finally(() => { spLoading = null; });
}
async function loadSpotifyHome_(s) {
  s.loadedAt = Date.now(); s.err = '';
  const tasks = [
    spRecent().then(v => s.recent = v)
  ];
  const res = await Promise.allSettled(tasks);
  const fail = res.find(x => x.status === 'rejected');
  if (fail) { s.err = fail.reason.message; s.recent ??= []; }
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
  const artists = ar.status === 'fulfilled' ? ar.value : [];
  state.results = { albums: al.status === 'fulfilled' ? al.value : [], artists,
    err: al.status === 'rejected' && ar.status === 'rejected' ? (al.reason?.message || '連線失敗') : '' };
  updateSearchBody();
  // 搜到演出者時，把他的專輯、單曲和迷你專輯全部列出來
  const top = artists[0];
  if (top?.id) {
    state.results.discFor = top.id; state.results.discLoading = true; updateSearchBody();
    try { const disc = await artistAlbums(top.id, top.name); if (seq === searchSeq) state.results.disc = disc; }
    catch (e) { if (seq === searchSeq) state.results.discErr = e.message; }
    if (seq === searchSeq) { state.results.discLoading = false; updateSearchBody(); }
  }
}

/* ---------- 已聽過 ---------- */
// 已聽過頁與封存頁共用：各自有搜尋字、篩選、排序、檢視方式
// 排序設定的對象：封存頁是 'archived'，其他就是目前的 tab
const libSt = () => state.view?.type === 'archive' ? 'archived' : state.tab;
const libQ = st => st === 'archived' ? state.archQ : state.libQ;
const libF = st => st === 'archived' ? state.archFilter : state.libFilter;
function renderLib(app, status = 'heard') {
  const isH = status === 'heard', name = isH ? '已聽過' : '已封存';
  let list = myAlbums().filter(a => a.status === status);
  const total = list.length, artists = new Set(list.map(a => norm(a.artist))).size;
  const lf = libF(status), lqs = libQ(status), vk = isH ? 'heard' : 'archive';
  if (lf) list = list.filter(a => inGroup(a, lf));
  if (lqs) { const q = lqs.toLowerCase(); list = list.filter(a => (a.title + ' ' + a.artist).toLowerCase().includes(q)); }
  const so = sortOf(status), sdef = sortsFor(status)[so.key];
  list.sort((a, b) => { const r = sdef.cmp(a, b, status) || timeOf(a, status) - timeOf(b, status); return so.desc ? -r : r; });
  remember(list);
  app.innerHTML = `${isH ? '' : `<div class="backbar plain"><button class="back" data-act="back">${I.back}返回</button></div>`}
    <div class="home-head"><header class="top"><div><h1>${name}</h1><div class="sub">${total} 張專輯 · ${artists} 位演出者</div></div>${isH ? gearBtn() : ''}</header></div>
    ${total ? `<div class="search-row${isH ? '' : ' under-back'}" style="padding-bottom:10px"><div class="search">${I.search}<input id="lq" type="search" placeholder="在${name}裡搜尋" value="${esc(lqs)}"></div></div>
    ${chipBar('lib', RELEASES, lf)}
    <div class="row-between" style="margin-bottom:12px">
      <button class="sort-btn" data-act="sortMenu">${I.sort}<span>${sdef.label(status)}</span></button>
      <div style="display:flex;gap:6px">${viewBtn(vk, ' style="width:34px;height:34px"')}<button class="icon-btn" data-act="sortFlip" aria-label="反轉順序" style="width:34px;height:34px">${I.flip}</button></div>
    </div>
    ${!list.length ? '<div class="empty">沒有符合的專輯</div>'
      : viewOf(vk) === 'list' ? `<div class="alist">${list.map((a, i) => albumRow(a, list.length - i)).join('')}</div>`
      : `<div class="grid small">${list.map(a => albumCard(a)).join('')}</div>`}`
    : isH ? `<div class="empty"><b>還沒有已聽過的專輯</b>到「首頁」找專輯，點 <span class="inline-ic">${I.check}</span> 標記已聽過</div>` : '<div class="empty">沒有封存的專輯</div>'}
    ${isH && archiveCount() ? `<button class="archive-link" data-act="archive">${I.archive}已封存 ${archiveCount()} 張 ›</button>` : ''}`;
  const lq = $('#lq'); if (lq) lq.oninput = e => { state[isH ? 'libQ' : 'archQ'] = e.target.value; const pos = e.target.selectionStart; render(); const n = $('#lq'); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ---------- 排序 ---------- */
// 筆畫排序：從第一個字開始逐字比筆畫（同筆畫數同一個字排在一起），不依賴手機瀏覽器的排序規則
// strokes.js 內是依筆畫排好的常用漢字表；英文／數字開頭的排在中文前面（依字母），再接中文依筆畫
const colLatin = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
let strokeRank = null;
const rankOf = ch => (strokeRank ||= new Map([...(window.STROKE_ORDER || '')].map((c, i) => [c, i]))).get(ch);
const colStroke = { compare(a, b) {
  const A = [...String(a || '').trim()], B = [...String(b || '').trim()];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (i >= A.length) return -1; if (i >= B.length) return 1;
    const ra = rankOf(A[i]), rb = rankOf(B[i]);
    if (ra !== undefined && rb !== undefined) { if (ra !== rb) return ra - rb; continue; }
    if (ra !== undefined) return 1; if (rb !== undefined) return -1;   // 由少到多：英文／數字在中文前面
    return colLatin.compare(A.slice(i).join(''), B.slice(i).join(''));
  }
  return 0;
} };
const timeOf = (a, st) => (st === 'heard' ? a.heardAt : st === 'archived' ? a.updatedAt : a.addedAt) || a.addedAt || 0;
// 每個排序：cmp 是「遞增」比較；dirs[0] 是遞增的說法、dirs[1] 是遞減；def 為預設是否遞減
const SORTS = {
  time:   { label: () => '最近新增', dirs: ['舊 → 新', '新 → 舊'], def: true,  cmp: (a, b, st) => timeOf(a, st) - timeOf(b, st) },
  artist: { label: () => '演出者',   dirs: ['少 → 多', '多 → 少'], def: false, cmp: (a, b) => colStroke.compare(a.artist, b.artist) || (a.year || '').localeCompare(b.year || '') },
  title:  { label: () => '專輯', dirs: ['少 → 多', '多 → 少'], def: false, cmp: (a, b) => colStroke.compare(a.title, b.title) }
};
// 演出者頁的排序：筆畫、聽過進度
const ARTIST_SORTS = {
  pct:  { label: () => '進度', dirs: ['低 → 高', '高 → 低'], def: true,  cmp: (a, b) => (a.pg ? a.pg.pct : -1) - (b.pg ? b.pg.pct : -1) },
  name: { label: () => '演出者',     dirs: ['少 → 多', '多 → 少'], def: false, cmp: (a, b) => colStroke.compare(a.name, b.name) }
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
  const st = libSt(), cur = sortOf(st);
  $('#sheet').innerHTML = `<div class="grab"></div><div class="sort-sheet"><div class="sort-h">分類方法</div>
    ${Object.entries(sortsFor(st)).map(([k, o]) => {
      const on = cur.key === k;
      return `<button class="sort-opt ${on ? 'on' : ''}" data-sort="${k}"><span>${o.label(st)}</span>${on ? I.check : ''}</button>`;
    }).join('')}</div>`;
  showSheet();
}

/* ---------- 封存 ---------- */
function renderArchive(app) { renderLib(app, 'archived'); }
const archiveCount = () => myAlbums().filter(a => a.status === 'archived').length;

/* ---------- 演出者 ---------- */
// 刪除演出者＝移除這位演出者所有的標記（已聽過／封存），會同步到雲端
async function deleteArtist(name) {
  const albums = Object.values(db.albums).filter(a => norm(a.artist) === norm(name));
  if (!albums.length) {
    if (!isFollowed(name)) return;
    const ok = await ask({ title: `移除「${name}」？`, msg: '會從演出者列表移除這位演出者。', ok: '移除', cancel: '取消' });
    if (!ok) { closeSwipes(); return; }
    setFollow(name, '', false); render(); return toast(`已移除「${name}」`);
  }
  const n = st => albums.filter(a => a.status === st).length;
  const parts = [['heard', '已聽過'], ['archived', '封存']].filter(([st]) => n(st)).map(([st, l]) => `${l} ${n(st)}`);
  const ok = await ask({
    title: `刪除「${name}」？`,
    msg: `會移除這位演出者全部 ${albums.length} 張的標記（${parts.join('、')}），無法復原。`,
    ok: '刪除', cancel: '取消'
  });
  if (!ok) { closeSwipes(); return; }
  const now = Date.now();
  albums.forEach(a => { const k = albumKey(a); delete db.albums[k]; db.deleted[k] = now; db.dirty[k] = 1; });
  if (isFollowed(name)) setFollow(name, '', false);
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
function goBack() {
  if (!state.view) return;
  const y = baseSnap?.y || 0;
  state.view = null; render(); window.scrollTo(0, y);
}
const TAB_ORDER = ['search', 'artists', 'heard'];
function switchTab(t) {
  if (t !== state.tab) { state.libQ = ''; state.artQ = ''; state.searchFocus = false; }
  state.tab = t; state.view = null; window.scrollTo(0, 0); render();
}
// 左右滑手勢（整個畫面都能滑，不限邊緣）：
// - 在演出者頁／封存頁：往右滑返回上一頁，頁面跟著手指，底下露出上一頁
// - 在首頁／演出者／已聽過：往左滑到下一個分頁、往右滑到上一個分頁
// - 演出者列表的列上往左滑仍是「刪除」；可以左右捲動的區塊不觸發
(() => {
  let tok = 0, on = false, busy = false, mode = null, kind = '', x0 = 0, y0 = 0, dx = 0, lastX = 0, lastT = 0, vx = 0, under = null, startRow = null;
  const app = () => $('#app');
  const W = () => innerWidth;
  const ease = ms => `transform ${ms}ms cubic-bezier(.2,.8,.2,1), opacity ${ms}ms`;
  const later = (fn, ms) => { const k = ++tok; requestAnimationFrame(() => { if (k === tok) fn(); }); return k; };
  const paintBack = d => {
    app().style.transform = `translate3d(${d}px,0,0)`;
    if (under) { under.firstChild.style.transform = `translate3d(${(d - W()) * 0.3}px,0,0)`; under.lastChild.style.opacity = String(0.35 * (1 - d / W())); }
  };
  const tabIdx = () => TAB_ORDER.indexOf(state.tab);
  const paintTab = d => {
    const i = tabIdx(), edge = (d > 0 && i === 0) || (d < 0 && i === TAB_ORDER.length - 1);
    const v = edge ? d * 0.25 : d;                    // 第一個／最後一個分頁：有阻力
    app().style.transform = `translate3d(${v}px,0,0)`;
    app().style.opacity = String(1 - Math.min(0.5, Math.abs(v) / W() * 0.8));
  };
  const makeUnder = () => {
    under = document.createElement('div'); under.className = 'swipe-under';
    const pg = document.createElement('div');
    pg.className = baseSnap?.cls || 'app'; pg.innerHTML = baseSnap?.html || '';
    pg.style.marginTop = `-${baseSnap?.y || 0}px`;
    const dim = document.createElement('div'); dim.className = 'swipe-dim';
    under.append(pg, dim); document.body.appendChild(under);
    app().classList.add('swiping');
  };
  const reset = () => {
    const a = app(); a.style.transition = ''; a.style.transform = ''; a.style.opacity = ''; a.classList.remove('swiping');
    under?.remove(); under = null; busy = false;
  };
  const animate = (paint, to, done) => {
    const ms = Math.round(Math.max(160, Math.min(300, Math.abs(to - dx) / Math.max(0.7, Math.abs(vx)))));
    app().style.transition = ease(ms);
    if (under) { under.firstChild.style.transition = ease(ms); under.lastChild.style.transition = `opacity ${ms}ms`; }
    const k = later(() => paint(to));
    setTimeout(() => { if (k === tok) done(); }, ms + 30);
  };
  const scrollsX = el => {
    for (; el && el !== document.body; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };
  document.addEventListener('touchstart', e => {
    on = false;
    if (busy || e.touches.length > 1 || $('#sheet').classList.contains('show')) return;
    if (!state.view && state.tab === 'search' && state.searchFocus) return;
    if (e.target.closest('input,textarea,select') || scrollsX(e.target)) return;
    const t = e.touches[0];
    on = true; mode = null; kind = state.view ? 'back' : 'tab';
    x0 = lastX = t.clientX; y0 = t.clientY; lastT = performance.now(); dx = 0; vx = 0;
    startRow = e.target.closest('.sw');
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!on) return;
    const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(mx) < Math.abs(my) * 1.2) { on = false; return; }   // 上下捲動
      if (kind === 'back' && mx < 0) { on = false; return; }
      // 演出者列表的列：往左滑交給刪除；已打開的列往右滑是收起
      if (startRow && (mx < 0 || startRow.classList.contains('open'))) { on = false; return; }
      mode = 'x'; busy = true;
      if (kind === 'back') makeUnder();
      x0 = t.clientX - (mx > 0 ? 1 : -1);             // 從這裡開始跟手，不會一下跳 10px
    }
    e.preventDefault();
    const now = performance.now();
    vx = (t.clientX - lastX) / Math.max(1, now - lastT); lastX = t.clientX; lastT = now;
    dx = t.clientX - x0;
    app().style.transition = 'none';
    if (kind === 'back') { dx = Math.max(0, dx); paintBack(dx); } else paintTab(dx);
  }, { passive: false });
  const end = () => {
    if (!on || mode !== 'x') { on = false; return; }
    on = false;
    const fast = Math.abs(vx) > 0.45 && Math.abs(dx) > 24 && Math.sign(vx) === Math.sign(dx);
    if (kind === 'back') {
      if (dx > W() * 0.35 || (fast && dx > 0)) animate(paintBack, W(), () => {
        const y = baseSnap?.y || 0; state.view = null;
        app().style.transition = 'none'; app().style.transform = '';
        render(); window.scrollTo(0, y); reset();
      });
      else animate(paintBack, 0, reset);
      return;
    }
    const dir = dx < 0 ? 1 : -1, next = TAB_ORDER[tabIdx() + dir];
    if (next && (Math.abs(dx) > W() * 0.3 || fast)) {
      animate(paintTab, -dir * W(), () => {
        const a = app();
        a.style.transition = 'none';
        switchTab(next);
        a.style.transform = `translate3d(${dir * W() * 0.3}px,0,0)`; a.style.opacity = '0';
        void a.offsetHeight;
        a.style.transition = ease(240);
        const k = later(() => { a.style.transform = ''; a.style.opacity = ''; });
        setTimeout(() => { if (k === tok) reset(); }, 270);
      });
    } else animate(paintTab, 0, reset);
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
})();
/* 演出者完整作品數的快取（只存在這台裝置），讓演出者列表不用點進去就能看到聽過百分比 */
try { localStorage.removeItem('heard.artistTotals'); } catch (e) {}
try { ['heard.artistTotals2', 'heard.artistTotals3'].forEach(k => localStorage.removeItem(k)); } catch (e) {}
const AT_KEY = 'heard.artistTotals4', AT_TTL = 3 * 864e5;
// 用搜尋拼湊的進度可能不完整，6 小時後就重新用完整清單算
const atStale = c => !c || Date.now() - c.at > (c.src === 'search' ? 6 * 36e5 : AT_TTL);
const artistTotals = (() => { try { const t = JSON.parse(localStorage.getItem(AT_KEY)) || {}; Object.keys(t).forEach(k => { if (!t[k]?.keys?.length) delete t[k]; }); return t; } catch (e) { return {}; } })();
function setArtistTotal(name, id, albums, img) {
  const prev = artistTotals[norm(name)];
  artistTotals[norm(name)] = { id, keys: albums.map(albumKey), at: Date.now(), src: albums.src || 'api', img: img ?? (prev?.id === id ? prev?.img : '') ?? '' };
  try { localStorage.setItem(AT_KEY, JSON.stringify(artistTotals)); } catch (e) {}
}
// 演出者列表與演出者頁共用：同一位演出者用同一個 Spotify id、同一套算法，數字才會一致
function rowArtistId(name) {
  let id = '';
  Object.values(db.albums).forEach(a => { if (norm(a.artist) === norm(name) && a.artistId) id = a.artistId; });
  return id;
}
function statsFor(name, discKeys) {
  const local = myAlbums().filter(a => norm(a.artist) === norm(name));
  const all = new Set([...discKeys, ...local.map(albumKey)]);
  const heard = [...all].filter(k => isDone(statusOf(k))).length;
  return { heard, total: all.size, pct: all.size ? Math.round(heard / all.size * 100) : 0 };
}
function artistProgress(name) {
  const c = artistTotals[norm(name)]; if (!c) return null;
  return statsFor(name, c.keys);
}
const atQueue = new Set(); let atRunning = 0, atRenderT = null, atDone = 0, atLimit = 15, atGap = 4000;
function queueArtistTotal(name, id) {
  const c = artistTotals[norm(name)];
  if (!spOn() || atQueue.has(name) || (c && !atStale(c) && c.img !== undefined && !freshKeys.has(name))) return;
  atQueue.add(name); pumpArtistTotals(id);
}
async function pumpArtistTotals() {
  const cw = Math.min(cooldownLeft('artists'), cooldownLeft('search'));
  if (cw) { setTimeout(pumpArtistTotals, cw * 1000 + 500); return; }
  if (atDone >= atLimit) return;
  if (discBusy) { setTimeout(pumpArtistTotals, atGap); return; }
  while (atRunning < 1 && atQueue.size) {
    atDone++;
    const name = atQueue.values().next().value; atQueue.delete(name); atRunning++;
    (async () => {
      try {
        const started = Date.now();
        const rid = rowArtistId(name);
        const id = isSpId(rid) ? rid : await resolveArtistId(name);
        if (freshKeys.has(name) && id) freshKeys.add(id);
        const albums = id ? await artistAlbums(id, name) : null;
        if (freshKeys.has(name)) { freshKeys.delete(name); freshKeys.delete(id); freshKeys.delete(encodeURIComponent(name)); }
        const img = id ? await artistImage(id, name).catch(() => '') : '';
        // 如果這段時間使用者已經點進演出者頁更新過，就不要覆蓋
        if (albums?.length && !albums.incomplete && !((artistTotals[norm(name)]?.at || 0) > started)) setArtistTotal(name, id, albums, img);
      } catch (e) {}
      atRunning--;
      if (artRefresh) {
        artRefresh.done++;
        if (artRefresh.done >= artRefresh.total || (!atQueue.size && !atRunning)) {
          refreshLog.unshift({ tab: 'artists-bg', at: new Date().toLocaleTimeString('zh-TW', { hour12: false }), ms: Date.now() - artRefresh.t0, n: artRefresh.total });
          toast(`已重新整理 ${artRefresh.total} 位演出者`); artRefresh = null;
        }
      }
      clearTimeout(atRenderT);
      atRenderT = setTimeout(() => { if (state.tab === 'artists' && !state.view && !state.current) render(); }, 400);
      if (!atQueue.size && !atRunning) atGap = 4000;
      setTimeout(pumpArtistTotals, atGap);
    })();
  }
}

// 演出者列表上的所有演出者名字（規則同 renderArtists）
function listedArtists() {
  const m = new Map();
  myAlbums().filter(a => a.status !== 'archived').forEach(a => m.set(norm(a.artist), a.artist));
  followed.forEach(f => { if (!m.has(norm(f.name))) m.set(norm(f.name), f.name); });
  return [...m.values()];
}
// 下拉重新整理演出者列表：每位演出者都不用快取、重新向 Spotify 抓完整作品數
let artRefresh = null;                  // 下拉重整演出者的進度 { total, done }
const refreshLog = [];                  // 診斷用：最近幾次下拉重整花多久、結果
function refreshAllArtists() {
  if (!spOn()) return 0;
  const names = listedArtists();
  artRefresh = names.length ? { total: names.length, done: 0, t0: Date.now() } : null;
  names.forEach(n => { freshKeys.add(n); freshKeys.add(encodeURIComponent(n)); atQueue.add(n); });
  atLimit = atDone + names.length; atGap = 1500;
  pumpArtistTotals();
  return names.length;
}
// 演出者列表的篩選：'undone' 未聽完、'done' 已聽完（100%）、'' 全部；存在這台裝置
function artistDoneFilter() {
  try {
    const v = localStorage.getItem('heard.artistDone');
    if (v !== null) return v;
    return localStorage.getItem('heard.hideDoneArtists') === '1' ? 'undone' : '';   // 舊設定
  } catch (e) { return ''; }
}
function renderArtists(app) {
  const map = new Map();
  // 規則：封存的專輯不會讓演出者出現在演出者列表（但演出者已在列表時，封存仍算進進度）
  myAlbums().filter(a => a.status !== 'archived').forEach(a => {
    const k = norm(a.artist);
    if (!map.has(k)) map.set(k, { id: '', name: a.artist, heard: [] });
    const g = map.get(k); if (a.artistId) g.id = a.artistId;   // 與 rowArtistId 規則相同
    g.heard.push(a);
  });
  followed.forEach(f => { const k = norm(f.name); if (!map.has(k)) map.set(k, { id: f.id || '', name: f.name, heard: [] }); else if (!map.get(k).id && f.id) map.get(k).id = f.id; });
  const all = [...map.values()];
  all.forEach(x => { x.pg = artistProgress(x.name); });
  const df = artistDoneFilter(), isDone100 = x => !!(x.pg && x.pg.pct >= 100);
  let list = df === 'undone' ? all.filter(x => !isDone100(x)) : df === 'done' ? all.filter(isDone100) : all;
  if (state.artQ) { const q = state.artQ.toLowerCase(); list = list.filter(x => x.name.toLowerCase().includes(q)); }
  const so = sortOf('artists'), sdef = ARTIST_SORTS[so.key];
  // 進度相同時，一律依筆畫由少到多（數字 → 英文 → 中文），不受反轉影響
  list.sort((a, b) => { const r = sdef.cmp(a, b); return r ? (so.desc ? -r : r) : colStroke.compare(a.name, b.name); });
  app.innerHTML = `
    <div class="home-head"><header class="top"><div><h1>演出者</h1>${all.length ? `<div class="sub">${all.length} 位演出者${artRefresh ? ` · 更新中 ${artRefresh.done}/${artRefresh.total}` : ''}</div>` : ''}</div>${gearBtn()}</header></div>
    ${all.length ? `<div class="search-row" style="padding-bottom:10px"><div class="search">${I.search}<input id="aq" type="search" placeholder="在演出者裡搜尋" value="${esc(state.artQ)}"></div></div>` : ''}
    ${all.length ? `${chipBar('done', [['undone', '未聽完'], ['done', '已聽完']], df || null, 'margin-bottom:10px')}` : ''}
    ${all.length ? `<div class="row-between" style="margin-bottom:12px">
      <button class="sort-btn" data-act="sortMenu">${I.sort}<span>${sdef.label()}</span></button>
      <div style="display:flex;gap:6px">${viewBtn('artists', ' style="width:34px;height:34px"')}<button class="icon-btn" data-act="sortFlip" aria-label="反轉順序" style="width:34px;height:34px">${I.flip}</button></div>
    </div>` : ''}
    ${list.length && viewOf('artists') === 'grid' ? `<div class="grid small artist-grid">${list.map(x => {
      const ce = artistTotals[norm(x.name)], c = ce?.img || x.heard[0]?.cover || '', pg = x.pg;
      if (!pg || atStale(ce) || ce.img === undefined) queueArtistTotal(x.name);
      return `<button class="acard" data-artist="${x.id}" data-name="${esc(x.name)}">
        <div class="acard-av">${c ? `<img loading="lazy" src="${esc(c)}" alt="">` : `<span>${esc(x.name[0])}</span>`}</div>
        <div class="acard-n">${esc(x.name)}</div>
        <div class="acard-p${pg ? '' : ' muted'}">${pg ? `${pg.pct}%` : `已聽 ${x.heard.length} 張`}</div></button>`;
    }).join('')}</div>`
    : list.length ? `<div class="list">${list.map(x => {
      const c = artistTotals[norm(x.name)]?.img || x.heard[0]?.cover || '';
      const pg = x.pg;
      const ce = artistTotals[norm(x.name)];
      if (!pg || atStale(ce) || ce.img === undefined) queueArtistTotal(x.name);
      return `<button class="li" data-artist="${x.id}" data-name="${esc(x.name)}">
        <div class="av">${c ? `<img src="${esc(c)}" alt="">` : esc(x.name[0])}</div>
        <div class="grow"><div class="row-between"><div class="name">${esc(x.name)}</div>${pg ? `<b class="pct">${pg.pct}%</b>` : ''}</div>
          <div class="muted small">${pg ? `聽過 ${pg.heard} / ${pg.total} 張` : `已聽 ${x.heard.length} 張${spOn() ? ' · 計算中…' : ''}`}</div>
          ${pg ? `<div class="bar"><i style="width:${pg.pct}%"></i></div>` : ''}</div>
        <span class="muted">›</span></button>`;
    }).join('')}</div>`
    : state.artQ ? '<div class="empty">沒有符合的演出者</div>' : all.length ? `<div class="empty">${df === 'done' ? '還沒有聽完的演出者' : '所有演出者都聽完了'}</div>` : `<div class="empty"><b>還沒有演出者</b>標記第一張專輯後，演出者會出現在這裡</div>`}`;
  const aq = $('#aq'); if (aq) aq.oninput = e => { state.artQ = e.target.value; const pos = e.target.selectionStart; render(); const n = $('#aq'); n.focus(); n.setSelectionRange(pos, pos); };
}

// 演出者頁的篩選標籤（未聽過、作品類型）所有演出者共用；存在手機上，關掉 App、結束背景後仍會記住
const AF_KEY = 'heard.artistFilter';
const loadArtistFilter = () => { try { return JSON.parse(localStorage.getItem(AF_KEY)) || {}; } catch (e) { return {}; } };
function saveArtistFilter(v) { try { localStorage.setItem(AF_KEY, JSON.stringify({ filter: v.filter || null, unheard: !!v.unheard })); } catch (e) {} }
try { localStorage.removeItem('heard.artistFilters'); } catch (e) {}
async function renderArtist(app) {
  const v = state.view;
  if (!('unheard' in v)) {
    const f = loadArtistFilter();
    v.unheard = !!f.unheard; v.filter = RELEASES.some(r => r[0] === f.filter) ? f.filter : null;
  }
  const head = `<div class="backbar"><button class="back" data-act="back">${I.back}返回</button></div>`;
  const local = myAlbums().filter(a => norm(a.artist) === norm(v.name));
  if (!v.albums) {
    app.innerHTML = `${head}<h2 style="margin:4px 0">${esc(v.name)}</h2><div class="spinner"></div>`;
    const done = list => {
      v.loading = false; v.albums = list; v.err = list.incomplete ? list.err : '';
      const cw = Math.min(cooldownLeft('artists'), cooldownLeft('search'));
      if (v.err && cw) setTimeout(() => { if (state.view === v) { delete v.albums; delete v.err; v.cached = false; render(); } }, cw * 1000 + 300);
    };
    try {
      if (!spOn()) v.albums = [];
      else {
        if (!isSpId(v.id)) v.id = await resolveArtistId(v.name);
        if (!v.id) v.albums = [];
        else {
          v.loading = true;
          const list = await artistAlbums(v.id, v.name, part => {
            if (state.view !== v) return;
            const first = !v.albums; v.albums = part;
            if (first || !$('#sheet.show')) render();
          });
          done(list);
        }
      }
    } catch (e) { done(Object.assign([], { incomplete: true, err: e.message || '載入失敗' })); }
    if (state.view !== v) return;
  }
  if (v.albums.length && !v.cached && !v.loading && !v.err) { setArtistTotal(v.name, v.id, v.albums); v.cached = true; }
  if (v.img === undefined && spOn() && isSpId(v.id)) {
    v.img = artistTotals[norm(v.name)]?.img || null;
    artistImage(v.id, v.name).then(img => {
      v.img = img || '';
      if (img) { const c = artistTotals[norm(v.name)]; if (c) { c.img = img; try { localStorage.setItem(AT_KEY, JSON.stringify(artistTotals)); } catch (e) {} } }
      const av = state.view === v && $('.artist-hero .av');
      if (av && img) av.innerHTML = `<img src="${esc(img)}" alt="">`;
    }).catch(() => { v.img = ''; });
  }
  const st = statsFor(v.name, v.albums.map(albumKey));
  const keys = new Set(v.albums.map(albumKey));
  const own = remember([...v.albums, ...local.filter(a => !keys.has(albumKey(a)))]);
  const ARTIST_OPTS = RELEASES;
  const all = own.filter(a => inGroup(a, v.filter));
  const groups = v.filter ? [[v.filter, ARTIST_OPTS.find(o => o[0] === v.filter)[1]]] : RELEASES;
  const counted = all;
  // 沒有篩選時直接用共用算法（跟演出者列表一致）；有篩選時算該分類
  const heard = v.filter ? counted.filter(a => isDone(statusOf(albumKey(a)))).length : st.heard;
  const totalN = v.filter ? counted.length : st.total;
  const pct = totalN ? Math.round(heard / totalN * 100) : 0;
  const cover = v.img || all.find(a => a.cover)?.cover;
  app.innerHTML = `${head}
    <div class="artist-hero">
      <div class="av">${cover ? `<img src="${esc(cover)}" alt="">` : ''}</div>
      <div style="flex:1;min-width:0"><h2>${esc(v.name)}</h2>
        <div class="row-between"><span class="muted small">聽過 ${heard} / ${totalN} 張</span><b style="font-size:18px">${pct}%</b></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        ${(() => { const inList = isFollowed(v.name) || local.some(a => a.status !== 'archived');
          return `<button class="follow-btn${inList ? ' on' : ''}" data-act="follow">${inList ? '已加入' : '加入'}</button>`; })()}
      </div>
    </div>
    ${chipBar('artist', ARTIST_OPTS, v.filter || null, 'margin-bottom:4px').replace('">', `"><button class="chip${v.unheard ? ' on' : ''}" data-act="unheardToggle">未聽過</button>`)}
    ${groups.map(([t, l]) => {
      const g = all.filter(a => inGroup(a, t));
      if (!g.length) return '';
      const h = g.filter(a => isDone(statusOf(albumKey(a)))).length;
      const shown = v.unheard ? g.filter(a => !isDone(statusOf(albumKey(a)))) : g;
      if (!shown.length) return '';
      return `<div class="section-h"><span>${l} · ${h}/${g.length}</span></div><div class="alist">${shown.map(a => albumRow(a)).join('')}</div>`;
    }).join('')}
    ${v.unheard && all.length && all.every(a => isDone(statusOf(albumKey(a)))) ? '<div class="empty">全部都聽過了</div>' : ''}
    ${v.loading ? '<div class="muted small" style="text-align:center;padding:14px 0">載入更多作品…</div>' : ''}
    ${v.err && all.length ? `<div class="empty" style="padding:18px 0">還有作品沒載入完<br><span class="small">${esc(v.err)}</span><br><button class="btn sm" style="margin-top:12px" data-act="artistRetry">重試</button></div>` : ''}
    ${!all.length ? (v.err ? `<div class="empty">載入失敗<br><span class="small">${esc(v.err)}</span><br><button class="btn sm" style="margin-top:12px" data-act="artistRetry">重試</button></div>`
      : v.filter ? '<div class="empty">這個分類沒有作品</div>' : `<div class="empty">Spotify 沒有回傳作品<br><button class="btn sm" style="margin-top:12px" data-act="artistRetry">重試</button></div>`) : ''}`;
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
    checkSaved(t);
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
  const had = seen.get(k)?._tracks; if (had?.length) checkSaved(had);
}
function metaHTML(a, tracks) {
  const totalMs = (tracks || []).reduce((t, x) => t + (x.ms || 0), 0);
  const n = tracks?.length || a.tracks;
  return `${typeLabel(a.type)}${a.year ? ' · ' + a.year : ''}${n ? ' · ' + n + ' 首' : ''}${totalMs ? ' · ' + fmtTotal(totalMs) : tracks === undefined && !a.manual ? ' · <span class="muted">計算時長…</span>' : ''}`;
}
function tracksHTML(tracks) {
  const fmt = ms => ms ? `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}` : '';
  return (tracks || []).map(t => `<div${t.id ? ` data-tid="${t.id}"` : ''}><span>${t.n}</span><b style="flex:1;font-weight:400">${esc(t.name)}</b><i class="saved-ic${savedTracks.get(t.id) ? ' on' : ''}">${I.savedOn}</i><em class="muted small" style="font-style:normal">${fmt(t.ms)}</em></div>`).join('');
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
  paintSaved();
}

/* ---------- 收藏的歌曲：跟原生 Spotify 一樣，存在「已按讚的歌曲」或自己的歌單裡就打勾（只讀，不會改動 Spotify） ---------- */
const savedTracks = new Map();          // 歌曲 id → 是否已收藏
const PL_KEY = 'heard.plIndex';
let plIndex = (() => { try { return JSON.parse(localStorage.getItem(PL_KEY)) || { at: 0, pl: {} }; } catch (e) { return { at: 0, pl: {} }; } })();
let plSet = new Set(Object.values(plIndex.pl).flatMap(p => p.ids || []));
let plLoading = null;
function paintSaved() {
  document.querySelectorAll('#sheetTracks [data-tid]').forEach(r => r.querySelector('.saved-ic')?.classList.toggle('on', !!savedTracks.get(r.dataset.tid)));
}
// 自己建立或共同編輯的歌單（Spotify 只開放這些歌單的內容）；歌單沒變（snapshot 相同）就不重抓
function loadPlaylists(force) {
  if (plLoading) return plLoading;
  if (!/playlist-read-private/.test(spTok?.scope || '')) { libDiag.plErr = '權限不足：Spotify 沒有給 playlist-read-private'; return Promise.resolve(); }
  if (!force && Date.now() - plIndex.at < 10 * 60e3) return Promise.resolve();
  return plLoading = (async () => {
    const me = await sp('/me');
    const lists = [];
    for (let url = '/me/playlists?limit=50'; url && lists.length < 500;) {
      const j = await sp(url); lists.push(...(j?.items || []).filter(Boolean));
      url = j?.next ? j.next.replace('https://api.spotify.com/v1', '') : null;
    }
    const next = {};
    for (const p of lists) {
      if (p.owner?.id !== me?.id && !p.collaborative) continue;
      const old = plIndex.pl[p.id];
      if (old && old.snap === p.snapshot_id) { next[p.id] = old; continue; }
      const ids = [];
      for (let url = `/playlists/${p.id}/items?limit=50`; url && ids.length < 5000;) {
        const j = await sp(url);
        (j?.items || []).forEach(it => { const tr = it?.item || it?.track; if (tr?.id) ids.push(tr.id); });
        url = j?.next ? j.next.replace('https://api.spotify.com/v1', '') : null;
        await sleep(120);
      }
      next[p.id] = { snap: p.snapshot_id, ids };
    }
    plIndex = { at: Date.now(), pl: next };
    plSet = new Set(Object.values(next).flatMap(p => p.ids));
    try { localStorage.setItem(PL_KEY, JSON.stringify(plIndex)); } catch (e) {}
  })().catch(e => { libDiag.plErr = e.message; console.warn('playlists', e); }).finally(() => { plLoading = null; });
}
const libDiag = { checks: 0, saved: 0, err: '', skipped: '' };
async function checkSaved(tracks) {
  if (!spOn()) return;
  if (!hasLibScope()) { libDiag.skipped = '權限不足：需要重新連結 Spotify'; return; }
  libDiag.skipped = '';
  const ids = (tracks || []).map(t => t.id).filter(Boolean);
  if (!ids.length) return;
  const mark = () => { ids.forEach(id => { if (plSet.has(id)) savedTracks.set(id, true); }); paintSaved(); };
  mark();                                   // 先用已知的歌單資料
  try {
    for (let i = 0; i < ids.length; i += 40) {
      const part = ids.slice(i, i + 40);
      const r = await sp('/me/library/contains?uris=' + part.map(id => 'spotify:track:' + id).join(','));
      if (Array.isArray(r)) { part.forEach((id, n) => savedTracks.set(id, !!r[n] || plSet.has(id))); libDiag.checks++; libDiag.saved += r.filter(Boolean).length; libDiag.err = ''; }
      else libDiag.err = '回應格式不對：' + JSON.stringify(r).slice(0, 80);
    }
  } catch (e) { libDiag.err = e.message; }
  mark();
  await loadPlaylists();
  mark();
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
      <button class="big-btn ${st === 'archived' ? 'arch' : ''}" data-arch="${esc(k)}">${st === 'archived' ? I.archiveOn : I.archive} ${st === 'archived' ? '已封存' : '封存'}</button>
      <button class="big-btn ${st === 'heard' ? 'heard' : st === 'archived' ? '' : 'solid'}" data-heard="${esc(k)}">${I.check} ${st === 'heard' ? '已聽過' : '標記已聽過'}</button>
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
        <form id="loginForm" method="post" action="#" style="margin-top:8px">
          <input id="email" name="username" type="email" autocomplete="username" inputmode="email" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Email" value="${esc(L.email || '')}" required>
          <input id="pw" name="password" type="password" autocomplete="current-password" placeholder="密碼（至少 6 個字）" minlength="6" required style="margin-top:8px">
          <div class="btn-row"><button class="btn" type="submit" name="signup">註冊</button><button class="btn primary" type="submit">登入</button></div>
        </form>
        ${L.err ? `<div class="err">${esc(L.err)}</div>` : ''}</div>`;
  const spBlock = !CFG.SPOTIFY_CLIENT_ID ? '<div class="muted small">尚未設定 Spotify（見 SETUP.md）</div>'
    : spOn() ? `<div class="panel row-between"><span>✓ 已連結 Spotify</span><button class="btn sm" data-act="spLogout">中斷連結</button></div>
      ${missingScopes().length ? '<button class="btn sm primary" style="margin-top:10px" data-act="spLogin">重新連結 Spotify 以顯示收藏的歌曲</button>' : ''}
      <button class="btn sm" style="margin-top:10px" data-act="copyDiag">複製診斷資料</button><div class="muted small" style="margin-top:8px">版本 ${APP_VER}</div>
      <details class="diag"><summary>連線診斷（最近 ${spLog.length} 次請求）</summary>${spLog.map(x => `<div class="diag-row ${x.ok ? '' : 'bad'}">
        <span>${new Date(x.t).toLocaleTimeString('zh-TW', { hour12: false })}</span><code>${esc(decodeURIComponent(x.path).slice(0, 90))}</code><b>${esc(x.info)}</b></div>`).join('') || '<div class="muted small">還沒有紀錄</div>'}</details>`
    : `<button class="btn primary" data-act="spLogin">連結 Spotify</button>`;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin:0">設定</h2>
    <div class="menu-h">雲端同步</div>${syncBlock}
    <div class="menu-h">SPOTIFY</div>${spBlock}
    <div class="menu-h">資料</div>
    <div class="list">
      <button class="li" data-act="archive"><div class="grow"><div class="name">已封存的專輯</div><div class="muted small">${archiveCount()} 張 · 封存的專輯在演出者進度中算作已聽過</div></div></button>
      <button class="li" data-act="manual"><div class="grow"><div class="name">手動新增專輯</div><div class="muted small">搜不到的獨立發行或實體 CD</div></div></button>
      <button class="li" data-act="export"><div class="grow"><div class="name">匯出備份</div><div class="muted small">下載 JSON 檔</div></div></button>
      <button class="li" data-act="import"><div class="grow"><div class="name">匯入備份</div><div class="muted small">合併到目前的資料</div></div></button>
    </div>
`;
  showSheet();
  const lf = $('#loginForm'); if (lf) lf.onsubmit = async e => {
    e.preventDefault(); L.err = '';
    const signup = e.submitter?.name === 'signup';
    if (signup) $('#pw').setAttribute('autocomplete', 'new-password');
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
    if (followedAt) db.dirty[META_FA] = 1;
    Object.keys(db.deleted).forEach(k => db.dirty[k] = 1);
    save(); toast('✓ 已登入，開始同步'); openMenu(); await syncNow(); if ($('#sheet').classList.contains('show')) openMenu();
  };
}
function openManual() {
  state.current = null;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin:0 0 4px">手動新增</h2><div class="muted small">搜不到的專輯（獨立發行、實體 CD…）可以自己加</div>
    <form id="mform">
      <div class="field"><label>演出者 *</label><input name="artist" required></div>
      <div class="field"><label>專輯名稱 *</label><input name="title" required></div>
      <div class="field" style="display:flex;gap:10px">
        <div style="flex:1"><label>類型</label><select name="type"><option value="Album">專輯</option><option value="EP">EP</option><option value="Single">單曲</option></select></div>
        <div style="flex:1"><label>年份</label><input name="year" inputmode="numeric" maxlength="4"></div>
      </div>
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
    seen.set(k, a); setStatus(k, 'heard'); closeSheet(true); toast('✓ 已加入');
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
    save(); scheduleSync(); closeSheet(true); toast(`匯入 ${n} 張新專輯`);
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
    const onBtn = e.target.closest('[data-heard],[data-arch]');
    if (op && !onBtn) { const a = findAlbum(op.dataset.open); if (a) { const { _tracks, ...clean } = a; addRecentSearch({ type: 'album', key: op.dataset.open, album: clean }); } }
    else if (ar && !op) addRecentSearch({ type: 'artist', name: ar.dataset.name, artistId: ar.dataset.artist, img: ar.querySelector('img')?.getAttribute('src') || '' });
  }
  const del = e.target.closest('[data-delartist]');
  if (del) return deleteArtist(del.dataset.delartist);
  const t = e.target.closest('[data-heard],[data-arch],[data-open],[data-name],[data-tab],[data-f],[data-sort],[data-view],[data-act]');
  if (!t) return;
  const d = t.dataset;
  if (d.heard !== undefined) { e.stopPropagation(); return toggle(d.heard, 'heard'); }
  if (d.arch !== undefined) { e.stopPropagation(); return toggle(d.arch, 'archived'); }
  if (d.open !== undefined) return openAlbum(d.open);
  if (d.name !== undefined) {
    if ($('#sheet').classList.contains('show')) hideSheet();
    state.view = { type: 'artist', id: d.artist || '', name: d.name }; window.scrollTo(0, 0); return render();
  }
  if (d.tab) {
    if (d.tab === state.tab && d.tab === 'search' && !state.view) { state.results = null; state.q = ''; }
    return switchTab(d.tab);
  }
  if (d.f) {
    const v = d.v || null;
    if (d.f === 'done') { try { localStorage.setItem('heard.artistDone', v || ''); } catch (e) {} return render(); }
    if (d.f === 'lib') {
      if (libSt() === 'archived') state.archFilter = v;
      else { state.libFilter = v; try { v ? localStorage.setItem('heard.libFilter', v) : localStorage.removeItem('heard.libFilter'); } catch (e) {} }   // 已聽過的標籤：關掉 App 後仍記得
    }
    else if (d.f === 'artist') { state.view.filter = v; saveArtistFilter(state.view); }
    else if (d.f === 'search') {
      state.sf = v;
      const need = v === 'artist' ? 'artist' : 'album';
      if (state.results && state.resKind !== need && state.q) { render(); return doSearch(state.q); }
    }
    return render();
  }
  if (d.view) { db.settings.view ??= {}; db.settings.view[state.tab] = d.view; save(); return render(); }
  if (d.sort) { setSort(libSt(), d.sort); hideSheet(); window.scrollTo(0, 0); return render(); }
  switch (d.act) {
    case 'back': return goBack();
    case 'clear': state.results = null; state.q = ''; return render();
    case 'menu': return openMenu();
    case 'copyDiag': {
      const txt = JSON.stringify({ v: 'diag3', app: APP_VER, disc: discStats, scrolled: document.documentElement.classList.contains('scrolled'), y: pageY(), now: new Date().toISOString(), cool: Object.fromEntries(Object.entries(spCool).map(([k, x]) => [k, { left: cooldownLeft(k), strikes: x.strikes }])),
        tokenExpIn: spTok ? Math.round((spTok.exp - Date.now()) / 1000) : null, scopes: SP_SCOPES, granted: spTok?.scope ?? '(未記錄，需重新連結)',
        lib: { ...libDiag, playlists: Object.keys(plIndex.pl).length, plTracks: plSet.size, plAt: plIndex.at ? new Date(plIndex.at).toLocaleString('zh-TW', { hour12: false }) : null }, refresh: refreshLog,
        log: spLog.map(x => ({ t: new Date(x.t).toLocaleTimeString('zh-TW', { hour12: false }), p: decodeURIComponent(x.path).slice(0, 120), ok: x.ok, i: x.info })) }, null, 1);
      try { await navigator.clipboard.writeText(txt); toast('已複製，貼給 Claude 就好'); }
      catch (err) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('已複製，貼給 Claude 就好'); }
      return;
    }
    case 'doneFilter': { try { localStorage.setItem('heard.artistDone', d.v || ''); } catch (e) {} return render(); }
    case 'follow': {
      const v = state.view; if (!v) return;
      const hasMarks = myAlbums().some(a => norm(a.artist) === norm(v.name) && a.status !== 'archived');
      // 已加入 → 移除（一定先跳確認）：有已聽過的專輯就連標記一起刪；只是加入的就只取消加入
      if (hasMarks) return deleteArtist(v.name);
      if (isFollowed(v.name)) {
        ask({ title: `移除「${v.name}」？`, msg: '會從演出者列表移除這位演出者。', ok: '移除', cancel: '取消' })
          .then(ok => { if (!ok) return; setFollow(v.name, v.id, false); render(); toast(`已移除「${v.name}」`); });
        return;
      }
      setFollow(v.name, isSpId(v.id) ? v.id : '', true); toast(`已加入「${v.name}」`);
      return render();
    }
    case 'unheardToggle': if (state.view) { state.view.unheard = !state.view.unheard; saveArtistFilter(state.view); } return render();
    case 'artistRetry': if (state.view) { delete state.view.albums; delete state.view.err; state.view.cached = false; } return render();
    case 'searchCancel': return endSearch();
    case 'clearRecent': recentSearches = []; saveRecentSearches(); return updateSearchBody();
    case 'viewToggle': { const st = d.st; db.settings.view ??= {}; db.settings.view[st] = viewOf(st) === 'list' ? 'grid' : 'list'; save(); return render(); }
    case 'archive': hideSheet(); state.archQ = ''; state.archFilter = null; state.view = { type: 'archive' }; window.scrollTo(0, 0); return render();
    case 'sortMenu': return openSortMenu();
    case 'sortFlip': { const st = libSt(), c = sortOf(st); db.settings.sort[st] = { key: c.key, desc: !c.desc }; save(); return render(); }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNow(); if (spOn() && Date.now() - (state.sp.loadedAt || 0) > 30000) loadSpotifyHome(true); } });
$('#scrim').onclick = () => closeSheet();
// 面板打開時，在背景遮罩上滑動不會捲動底下的頁面
$('#scrim').addEventListener('touchmove', e => e.preventDefault(), { passive: false });
// 下拉重新整理（首頁／演出者／已聽過）：首頁重抓最近播放；演出者重抓每位的完整作品數；三頁都會完整雲端同步
(() => {
  const TH = 70, MAX = 110;
  let y0 = 0, x0 = 0, pull = 0, on = false, mode = null, busy = false;
  const ptr = document.createElement('div');
  ptr.id = 'ptr'; ptr.innerHTML = '<div class="ptr-ic"></div>';
  document.body.appendChild(ptr);
  const app = () => $('#app');
  const ok = () => !state.view && (state.tab !== 'search' || (!state.searchFocus && !state.results && !state.q))
    && !(document.activeElement && document.activeElement.tagName === 'INPUT')
    && !$('#sheet').classList.contains('show') && !document.querySelector('.dialog');
  const paint = (d, anim) => {
    const a = app();
    [a, ptr].forEach(el => el.style.transition = anim ? 'transform .25s ease, opacity .25s' : 'none');
    a.style.transform = d ? `translateY(${d}px)` : '';
    ptr.style.transform = `translateY(${d - 40}px)`;
    ptr.style.opacity = d ? Math.min(1, d / TH) : 0;
    ptr.firstChild.style.transform = `rotate(${d * 4}deg)`;
    ptr.classList.toggle('ready', d >= TH);
  };
  document.addEventListener('touchstart', e => {
    if (busy || e.touches.length !== 1 || !ok() || (window.scrollY || document.documentElement.scrollTop) > 0) return;
    on = true; mode = null; pull = 0; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!on) return;
    const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (!mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      mode = dy > 0 && Math.abs(dy) > Math.abs(dx) && (window.scrollY || 0) <= 0 ? 'pull' : 'no';
      if (mode === 'no') { on = false; return; }
    }
    e.preventDefault();
    pull = Math.min(MAX, dy > 0 ? dy * 0.5 : 0);
    paint(pull);
  }, { passive: false });
  const end = async () => {
    if (!on) return; on = false;
    if (mode !== 'pull') return;
    if (pull < TH) return paint(0, true);
    busy = true; ptr.classList.add('busy'); paint(56, true);
    const t0 = Date.now(), tab = state.tab;
    // 雲端同步：如果剛好在同步，等它結束再完整同步一次
    const sync = async () => { if (!sbUser) return; for (let i = 0; syncing && i < 40; i++) await sleep(250); await syncNow(); };
    let msg = '', n = 0;
    const syncMsg = () => !sbUser ? '' : state.syncErr ? '同步失敗：' + state.syncErr : '已同步';
    try {
      if (tab === 'search') {
        if (spOn() && spLoading) await spLoading.catch(() => {});   // 先等前一次抓完，再強制重抓一次最新的
        await Promise.allSettled([spOn() ? loadSpotifyHome(true) : null, sync()]);
        msg = state.sp.err ? '最近播放更新失敗：' + state.sp.err : spOn() ? '最近播放已更新' : syncMsg();
      } else if (tab === 'artists') {
        await sync();
        n = refreshAllArtists();   // 每位演出者在背景一位一位重抓，標題下方顯示進度，全部完成會提示
        msg = n ? '' : syncMsg();
      } else {
        await sync();
        msg = syncMsg();
      }
    } catch (e) { msg = '重新整理失敗：' + e.message; }
    refreshLog.unshift({ tab, at: new Date().toLocaleTimeString('zh-TW', { hour12: false }), ms: Date.now() - t0, msg: msg || `演出者 ${n} 位排入重抓` });
    refreshLog.length = Math.min(refreshLog.length, 8);
    if (msg) toast(msg);
    if (Date.now() - t0 < 500) await new Promise(r => setTimeout(r, 500 - (Date.now() - t0)));
    ptr.classList.remove('busy'); busy = false; paint(0, true);
    if (state.tab !== tab || state.view) return;
    if (tab === 'search') { if (!state.results) updateSearchBody(); } else render();
  };
  document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
})();

// 專輯列表的點擊：手指放開就直接打開（iPhone 點在文字上有時不會觸發 click）
(() => {
  let row = null, x0 = 0, y0 = 0, t0 = 0, moved = false;
  document.addEventListener('touchstart', e => {
    row = null;
    if (e.touches.length > 1) return;
    const r = e.target.closest('.arow[data-open], .srow[data-open]');
    if (!r || e.target.closest('button,[data-heard],[data-arch],a,input')) return;
    row = r; moved = false; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (row && (Math.abs(e.touches[0].clientX - x0) > 8 || Math.abs(e.touches[0].clientY - y0) > 8)) moved = true;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const r = row; row = null;
    if (!r || moved || Date.now() - t0 > 600 || !document.contains(r)) return;
    if ($('#sheet').classList.contains('show')) return;
    e.preventDefault();                       // 不再產生 click，避免打開兩次
    r.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, { passive: false });
})();
// 面板打開時，後面的頁面不能被捲動：面板內容捲到底（或本來就不用捲）時，擋掉往後面頁面傳的捲動
(() => {
  let sy = 0;
  document.addEventListener('touchstart', e => { sy = e.touches[0]?.clientY || 0; }, { passive: true, capture: true });
  document.addEventListener('touchmove', e => {
    const s = $('#sheet');
    if (!s.classList.contains('show') || e.defaultPrevented) return;
    if (!s.contains(e.target)) { e.preventDefault(); return; }
    const dy = (e.touches[0]?.clientY || 0) - sy;
    const max = s.scrollHeight - s.clientHeight;
    if (max <= 1 || (dy < 0 && s.scrollTop >= max - 1) || (dy > 0 && s.scrollTop <= 0)) e.preventDefault();
  }, { passive: false });
})();
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
  purgeWant(); migrateKeys(); save();
  await spotifyCallback();
  const wantNp = new URLSearchParams(location.search).has('np');
  if (wantNp) history.replaceState(null, '', spRedirect());
  render();
  initSync();
  if (wantNp) quickNowPlaying();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
