'use strict';

/* ============================================================
    TONIN CONECT - serveur

    PERSISTANCE (important) :
    1) Par défaut : fichiers dans le dossier ./data (db.json + sauvegarde
       db.json.bak + photos). Ça survit aux redémarrages SI le disque est
       conservé (ton PC, un VPS, un disque persistant monté...).
       Le dossier peut être changé avec la variable DATA_DIR.
    2) Si ton hébergeur efface le disque à chaque redémarrage / mise en
       veille (Render gratuit, Railway sans volume, Glitch, Replit...),
       définis la variable DATABASE_URL avec l'adresse d'une base
       PostgreSQL gratuite (Neon, Supabase, Render Postgres...).
       Tout (comptes, PIN, amis, codes, messages, photos) est alors
       stocké dans cette base et ne disparaît plus jamais.

   Variables d'environnement :
      PORT          port du serveur (défaut 3000)
      ADMIN_PIN     code administrateur initial (défaut 137920)
      DATA_DIR      dossier des données en mode fichier
      DATABASE_URL  adresse PostgreSQL (active le mode base de données)
      PGSSL=disable désactive SSL pour un PostgreSQL local
   ============================================================ */

// Lit le fichier .env (s'il existe) sans aucun module supplémentaire.
// Les variables déjà définies par l'hébergeur (Render...) restent prioritaires.
try {
  const envFile = require('path').join(__dirname, '.env');
  if (require('fs').existsSync(envFile)) {
    for (const line of require('fs').readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch (e) { /* ignore */ }

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DEFAULT_ADMIN_PIN = String(process.env.ADMIN_PIN || '137920');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

const PIN_RE = /^\d{4}$/;
const RESERVED = ['admin', 'administrateur', 'administrator'];
const THEMES = ['dark', 'light'];
const ACCENTS = ['violet', 'ocean', 'menthe', 'rose', 'pink', 'orange'];
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', weba: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg' };

const ICON_URL =
  'https://github.com/antoninlempereur24-bot/tonin-conect/blob/main/pdp%20tonin%20coco%20.jpg?raw=true';
// Change ce numéro à chaque fois que tu changes le logo : ça force les téléphones à le retélécharger
const ICON_VERSION = '3';

/* ------------------------- Base de données (mémoire) ------------------------- */

const emptyDb = () => ({
  users: [],
  messages: [],
  sessions: {},
  admin: { pin: '', avatar: '', appearance: null, pinned: [] },
  reports: [],
  stories: [],
  calls: [],
  channels: [],
  banRequests: [],
  groups: [],
  banLog: [],
  accessLog: [],
});

let db = emptyDb();
let storage = null;

function normalizeDb(d) {
  const base = emptyDb();
  if (!d) return base;
  return {
    users: Array.isArray(d.users) ? d.users : [],
    messages: Array.isArray(d.messages) ? d.messages : [],
    sessions: d.sessions && typeof d.sessions === 'object' ? d.sessions : {},
    admin: Object.assign(base.admin, d.admin || {}),
    reports: Array.isArray(d.reports) ? d.reports : [],
    stories: Array.isArray(d.stories) ? d.stories : [],
    calls: Array.isArray(d.calls) ? d.calls : [],
    channels: Array.isArray(d.channels) ? d.channels : [],
    banRequests: Array.isArray(d.banRequests) ? d.banRequests : [],
    groups: Array.isArray(d.groups) ? d.groups : [],
    banLog: Array.isArray(d.banLog) ? d.banLog : [],
    accessLog: Array.isArray(d.accessLog) ? d.accessLog : [],
  };
}

function pruneSessions() {
  const limit = Date.now() - 180 * 24 * 3600 * 1000; // 180 jours
  for (const t of Object.keys(db.sessions)) {
    if ((db.sessions[t].createdAt || 0) < limit) delete db.sessions[t];
  }
}

/* ---------------------- Stockage 1 : fichiers locaux ---------------------- */

function createFileStorage() {
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  const BAK_FILE = DB_FILE + '.bak';
  const UPLOADS = path.join(DATA_DIR, 'uploads');
  let lastBackup = 0;

  return {
    mode: 'file',
    label: 'Fichiers locaux (' + DATA_DIR + ')',
    async init() {
      fs.mkdirSync(UPLOADS, { recursive: true });
    },
    async load() {
      let found = null;
      let hadFile = false;
      // db.json, sa sauvegarde, puis l'ancien emplacement (ancienne version de l'appli)
      for (const f of [DB_FILE, BAK_FILE, path.join(__dirname, 'db.json')]) {
        if (!fs.existsSync(f)) continue;
        hadFile = true;
        try {
          found = JSON.parse(fs.readFileSync(f, 'utf8'));
          console.log('Données chargées depuis', f);
          break;
        } catch (e) {
          console.error('Fichier illisible :', f, '-', e.message);
        }
      }
      if (!found && hadFile) {
        throw new Error('Des fichiers de données existent mais sont illisibles. Arrêt pour ne rien écraser.');
      }
      return found;
    },
    async saveCore() {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      if (fs.existsSync(DB_FILE) && Date.now() - lastBackup > 60000) {
        try { fs.copyFileSync(DB_FILE, BAK_FILE); lastBackup = Date.now(); } catch (e) { /* ignore */ }
      }
      fs.renameSync(tmp, DB_FILE);
    },
    async appendMessage() { /* inclus dans saveCore */ },
    async updateMessage() { /* inclus dans saveCore */ },
    async deleteMessage() { /* inclus dans saveCore */ },
    async removeMessagesFor() { /* inclus dans saveCore */ },
    async putFile(name, buf) { fs.writeFileSync(path.join(UPLOADS, name), buf); },
    async getFile(name) {
      try { return fs.readFileSync(path.join(UPLOADS, name)); } catch (e) { return null; }
    },
    async delFile(name) {
      try { fs.unlinkSync(path.join(UPLOADS, name)); } catch (e) { /* ignore */ }
    },
    async close() {},
  };
}

/* ------------------------ Stockage 2 : PostgreSQL ------------------------ */

function readLegacyFile() {
  for (const f of [path.join(DATA_DIR, 'db.json'), path.join(__dirname, 'db.json')]) {
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* ignore */ }
    }
  }
  return null;
}

/* Configuration PostgreSQL explicite : uniquement DATABASE_URL, jamais de repli vers localhost. */
const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.RENDER || process.env.DYNO || process.env.RAILWAY_ENVIRONMENT);

function pgConfig() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL est vide : impossible de se connecter à PostgreSQL.');
  if (!/^postgres(ql)?:\/\//i.test(connectionString)) throw new Error('DATABASE_URL doit commencer par postgresql://');
  const isLocal = /^postgres(ql)?:\/\/(?:[^@\/]*@)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:\/?#]|$)/i.test(connectionString);
  if (isLocal && IS_PROD) throw new Error('DATABASE_URL pointe vers localhost en production : refusé.');
  return {
    // L'URL complète est transmise telle quelle à « pg », qui gère lui-même l'analyse et la connexion.
    connectionString,
    // Supabase : certificat accepté même s'il n'est pas dans la liste du système
    ssl: process.env.PGSSL === 'disable' && !IS_PROD ? false : { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000,
  };
}

function createPgStorage() {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    throw new Error('Le module "pg" est introuvable. Lance « npm install » (il est dans package.json).');
  }
  const pool = new Pool(pgConfig());
  pool.on('error', (e) => console.error('PostgreSQL :', e.message));

  const insertMessage = (m) =>
    pool.query(
      'INSERT INTO messages(id, from_id, to_id, text, image, ts, edited, audio) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
      [m.id, m.from, m.to, m.text || '', m.image || null, m.ts, !!m.edited, m.audio || null]
    );

  return {
    mode: 'postgres',
    label: 'Base PostgreSQL (durable)',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
      await pool.query(
        'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT, image TEXT, ts BIGINT NOT NULL)'
      );
      await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE');
      await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio TEXT');
      await pool.query('CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts)');
      await pool.query('CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BYTEA NOT NULL)');
    },
    async load() {
      const core = await pool.query("SELECT value FROM kv WHERE key = 'core'");
      const msgs = await pool.query('SELECT id, from_id, to_id, text, image, ts, edited, audio FROM messages ORDER BY ts ASC');
      if (!core.rows.length && !msgs.rows.length) {
        const legacy = readLegacyFile();
        if (legacy) {
          console.log('Import des anciennes données (db.json) vers PostgreSQL...');
          for (const m of legacy.messages || []) await insertMessage(m);
          return legacy;
        }
        return null;
      }
      const data = core.rows[0] ? core.rows[0].value : {};
      data.messages = msgs.rows.map((r) => {
        const m = { id: r.id, from: r.from_id, to: r.to_id, text: r.text || '', ts: Number(r.ts) };
        if (r.image) m.image = r.image;
        if (r.edited) m.edited = true;
        if (r.audio) m.audio = r.audio;
        return m;
      });
      return data;
    },
    async saveCore() {
      const core = { users: db.users, sessions: db.sessions, admin: db.admin, reports: db.reports, stories: db.stories, calls: db.calls, channels: db.channels, banRequests: db.banRequests, groups: db.groups, banLog: db.banLog, accessLog: db.accessLog };
      await pool.query(
        "INSERT INTO kv (key, value) VALUES ('core', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify(core)]
      );
    },
    async appendMessage(m) { await insertMessage(m); },
    async updateMessage(m) {
      await pool.query('UPDATE messages SET text = $2, edited = $3 WHERE id = $1', [m.id, m.text || '', !!m.edited]);
    },
    async deleteMessage(id) { await pool.query('DELETE FROM messages WHERE id = $1', [id]); },
    async migrateSystem() {
      await pool.query("UPDATE messages SET from_id = 'system' WHERE from_id = 'admin' AND (text LIKE '⚠️ %' OR text LIKE '🔔 %' OR text LIKE '✅ %' OR text LIKE '❌ %')");
    },
    async removeMessagesFor(id) {
      await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [id]);
    },
    async putFile(name, buf) {
      await pool.query('INSERT INTO files (name, data) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data', [name, buf]);
    },
    async getFile(name) {
      const r = await pool.query('SELECT data FROM files WHERE name = $1', [name]);
      return r.rows[0] ? r.rows[0].data : null;
    },
    async delFile(name) { await pool.query('DELETE FROM files WHERE name = $1', [name]); },
    async close() { await pool.end(); },
  };
}

/* ------------------------ Sauvegarde différée mais sûre ------------------------ */

let saveTimer = null;
let dirty = false;
let saveChain = Promise.resolve();

async function doSave() {
  if (!dirty) return;
  dirty = false;
  try {
    await storage.saveCore();
  } catch (e) {
    console.error('Sauvegarde échouée (nouvel essai dans 5 s) :', e.message);
    dirty = true;
    setTimeout(scheduleSave, 5000);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveChain = saveChain.then(doSave);
  }, 200);
}

async function flushAll() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveChain = saveChain.then(doSave);
  await saveChain;
}

const saveDb = scheduleSave;

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Arrêt du serveur : sauvegarde des données...');
  try {
    await flushAll();
    if (storage) await storage.close();
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => console.error('Erreur non gérée :', e));
process.on('unhandledRejection', (e) => console.error('Promesse rejetée :', e));

function ephemeralHostSuspected() {
  const e = process.env;
  return !DATABASE_URL && !e.DATA_DIR && !!(e.RENDER || e.RAILWAY_ENVIRONMENT || e.DYNO || e.FLY_APP_NAME || e.K_SERVICE || e.GLITCH_DOMAIN || e.REPL_ID);
}

/* ----------------------------- Utilitaires ----------------------------- */

const uid = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const getAdminPin = () => db.admin.pin || DEFAULT_ADMIN_PIN;

function newShareCode() {
  const used = new Set(db.users.map((u) => u.shareCode));
  if (used.size >= 10000) throw new Error('Plus de codes de partage disponibles');
  for (;;) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!used.has(c)) return c;
  }
}

const getUser = (id) => db.users.find((u) => u.id === id);
const findByPseudo = (p) => db.users.find((u) => u.pseudo.toLowerCase() === p.toLowerCase());

function isGroupId(x) { return typeof x === 'string' && x.startsWith('g_'); }
function getGroup(id) { return db.groups.find((g) => g.id === id); }
function msgRooms(m) {
  if (isGroupId(m.to)) { const g = getGroup(m.to); return g ? [...g.members] : [m.from]; }
  return [m.from, m.to];
}
function emitMsg(ev, m, payload) { for (const r of msgRooms(m)) io.to(r).emit(ev, payload || m); }

function cleanPseudo(x) {
  const p = String(x || '').trim().replace(/\s+/g, ' ');
  return p.length >= 2 && p.length <= 20 ? p : '';
}

function normalizeAvatar(a) {
  if (typeof a !== 'string') return a;
  a = a.trim();
  // lien GitHub "blob" => on force le fichier brut pour que ce soit une vraie image
  if (/^https?:\/\/github\.com\/.+\/blob\//i.test(a) && !/[?&]raw=true/i.test(a)) {
    a += (a.includes('?') ? '&' : '?') + 'raw=true';
  }
  return a;
}

function validAvatar(a) {
  if (a === '') return true;
  if (typeof a !== 'string' || a.length > 250000) return false;
  return /^https?:\/\//i.test(a) || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(a);
}

// Limiteur simple contre les essais de PIN en boucle
const attempts = new Map();
function limited(req) {
  const ip = req.ip;
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) {
    a = { n: 0, reset: now + 5 * 60 * 1000 };
    attempts.set(ip, a);
  }
  a.n++;
  return a.n > 20;
}

/* ----------------------------- Présence ----------------------------- */

const online = new Map(); // userId -> nombre de sockets
const isOnline = (id) => (online.get(id) || 0) > 0;

/* ------------------------ Représentation des users ------------------------ */

const DEFAULT_APPEARANCE = { theme: 'dark', accent: 'violet' };
const DEFAULT_ADMIN_DESC = 'Je suis là pour t\'aider si tu as des questions ou un souci avec l\'application. N\'hésite pas à m\'écrire !';
const SYSTEM_DESC = 'Notifications automatiques de l\'application (avertissements, suppressions, annonces). Tu ne peux pas répondre ici : pour toute question, écris à l\'Administrateur.';

function adminPublic() {
  return { id: 'admin', pseudo: 'Administrateur', nickname: '', name: 'Administrateur', avatar: db.admin.avatar || '', description: db.admin.description || DEFAULT_ADMIN_DESC, isAdmin: true, online: isOnline('admin') };
}

function systemPublic() {
  return { id: 'system', pseudo: 'Système', nickname: '', name: 'Système', avatar: '', description: SYSTEM_DESC, isAdmin: false, isSystem: true, online: false };
}

function publicUser(u) {
  return { id: u.id, pseudo: u.pseudo, nickname: u.nickname || '', name: u.nickname || u.pseudo, avatar: u.avatar || '', isAdmin: false, staff: !!u.admin, online: isOnline(u.id) };
}

function meFull(userId) {
  if (userId === 'admin') {
    return {
      id: 'admin',
      pseudo: 'Administrateur',
      nickname: '',
      name: 'Administrateur',
      avatar: db.admin.avatar || '',
      description: db.admin.description || '',
      isAdmin: true,
      staff: true,
      appearance: db.admin.appearance || DEFAULT_APPEARANCE,
    };
  }
  const u = getUser(userId);
  return {
    id: u.id,
    pseudo: u.pseudo,
    nickname: u.nickname || '',
    name: u.nickname || u.pseudo,
    avatar: u.avatar || '',
    pin: u.pin,
    shareCode: u.shareCode,
    isAdmin: false,
    staff: !!u.admin,
    isPublic: !!u.isPublic,
    appearance: u.appearance || DEFAULT_APPEARANCE,
  };
}

function canChat(a, b) {
  if (a === b) return false;
  if (isGroupId(b)) { const g = getGroup(b); return !!g && g.members.includes(a); }
  if (isGroupId(a)) return false;
  if (b === 'system') return !!getUser(a);
  if (a === 'system') return !!getUser(b);
  if (a === 'admin') return !!getUser(b);
  if (b === 'admin') return !!getUser(a);
  const ua = getUser(a);
  return !!ua && !!getUser(b) && ua.contacts.includes(b);
}

// Conversations épinglées par chaque compte (enregistrées côté serveur : elles suivent le compte sur tous les appareils)
function pinnedOf(userId) {
  if (userId === 'admin') return Array.isArray(db.admin.pinned) ? db.admin.pinned : [];
  const u = getUser(userId);
  return u && Array.isArray(u.pinned) ? u.pinned : [];
}

function contactListFor(userId) {
  const viewer = userId === 'admin' ? null : getUser(userId);
  let list;
  if (!viewer) {
    list = db.users.map(publicUser);
  } else {
    list = viewer.contacts.map(getUser).filter(Boolean).map(publicUser);
  }
  const groupsFor = viewer ? db.groups.filter((g) => g.members.includes(userId)) : [];
  const gids = new Set(groupsFor.map((g) => g.id));
  groupsFor.forEach((g) => {
    list.push({
      id: g.id, pseudo: g.name, nickname: '', name: g.name, avatar: g.avatar || '', isAdmin: false, isGroup: true, online: false, ownerId: g.ownerId,
      members: g.members.map((mid) => ({ id: mid, name: displayName(userId, mid), avatar: avatarOf(mid) })),
    });
  });
  const last = {};
  for (const m of db.messages) {
    if (m.from === userId) last[m.to] = m;
    else if (m.to === userId) last[m.from] = m;
    else if (gids.has(m.to)) last[m.to] = m;
  }
  // « Administrateur » est toujours présent ; « Système » seulement après sa première notification
  if (viewer) {
    list.unshift(adminPublic());
    if (last.system) list.unshift(systemPublic());
  }
  const pins = new Set(pinnedOf(userId));
  return list.map((c) => {
    const u = c.isAdmin ? null : getUser(c.id);
    const alias = (viewer && viewer.aliases && viewer.aliases[c.id]) || '';
    return {
      ...c,
      name: alias || c.name,
      alias,
      shareCode: u ? u.shareCode : '',
      isPublic: !!(u && u.isPublic),
      since: (viewer && viewer.addedAt && viewer.addedAt[c.id]) || null,
      pinned: pins.has(c.id),
      last: last[c.id] || null,
    };
  });
}

/* ------------------------------ Express ------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

app.set('trust proxy', true);
app.use(express.json({ limit: '10mb' }));

// On ne sert QUE les fichiers publics (jamais les données ni server.js)
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (q, r) => r.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (q, r) => r.sendFile(path.join(__dirname, 'script.js')));
app.get('/healthz', (q, r) => r.type('text/plain').send('ok'));

/* --------- Icône de l'application + PWA --------- */

let iconCache = null; // { buf, type }
function sniffImage(buf) {
  if (buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}
async function getIcon() {
  // si tu poses ton propre icon.png / icon.jpg à côté de server.js, il est prioritaire
  for (const f of ['icon.png', 'icon.jpg']) {
    const local = path.join(__dirname, f);
    if (fs.existsSync(local)) {
      const buf = fs.readFileSync(local);
      const type = sniffImage(buf);
      if (type) return { buf, type };
    }
  }
  // le cache mémoire expire au bout de 5 min (avant, l'ancien logo restait tant que le serveur ne redémarrait pas)
  if (iconCache && Date.now() - iconCache.at < 5 * 60 * 1000) return iconCache;
  if (typeof fetch !== 'function') return null;
  try {
    const r = await fetch(ICON_URL + '&t=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const type = sniffImage(buf);
    if (!type) throw new Error('le fichier n\'est pas une image PNG/JPEG');
    iconCache = { buf, type, at: Date.now() };
    return iconCache;
  } catch (e) {
    console.error('Icône non téléchargée :', e.message);
    return null;
  }
}

app.get(
  ['/icon.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon.ico', '/icon-192.png', '/icon-512.png'],
  async (req, res) => {
    const icon = await getIcon();
    if (!icon) return res.redirect(ICON_URL);
    res.set('Content-Type', icon.type);
    res.set('Cache-Control', 'no-cache');
    res.send(icon.buf);
  }
);

app.get('/manifest.webmanifest', async (q, r) => {
  const icon = await getIcon();
  const type = icon ? icon.type : 'image/png';
  r.set('Cache-Control', 'no-cache');
  r.type('application/manifest+json').json({
    id: '/',
    name: 'Tonin Conect',
    short_name: 'Tonin Conect',
    description: 'Messagerie instantanée Tonin Conect',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f1220',
    theme_color: '#0f1220',
    lang: 'fr',
    icons: [
      { src: '/icon-192.png?v=' + ICON_VERSION, sizes: '192x192', type, purpose: 'any' },
      { src: '/icon-512.png?v=' + ICON_VERSION, sizes: '512x512', type, purpose: 'any' },
      // "maskable" = l'image remplit tout le carré, sans bord blanc/noir ajouté par Android
      { src: '/icon-192.png?v=' + ICON_VERSION, sizes: '192x192', type, purpose: 'maskable' },
      { src: '/icon-512.png?v=' + ICON_VERSION, sizes: '512x512', type, purpose: 'maskable' },
    ],
  });
});

app.get('/sw.js', (q, r) => {
  r.type('application/javascript').set('Cache-Control', 'no-cache').send(
    "self.addEventListener('install',()=>self.skipWaiting());" +
      "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" +
      "self.addEventListener('fetch',()=>{});"
  );
});

/* --------- Photos envoyées dans les discussions --------- */

app.get('/uploads/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[a-f0-9]{24}\.(jpg|png|webp|gif|mp4|webm|mov|weba|m4a|ogg)$/.test(name)) return res.status(404).end();
  try {
    const buf = await storage.getFile(name);
    if (!buf) return res.status(404).end();
    res.set('Content-Type', MIME[name.split('.')[1]]);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('Accept-Ranges', 'bytes');
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {
      const total = buf.length;
      const start = rg[1] ? parseInt(rg[1], 10) : Math.max(0, total - parseInt(rg[2], 10));
      const end = rg[1] && rg[2] ? Math.min(parseInt(rg[2], 10), total - 1) : total - 1;
      if (start > end || start >= total) return res.status(416).set('Content-Range', 'bytes */' + total).end();
      return res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + total).send(buf.subarray(start, end + 1));
    }
    res.send(buf);
  } catch (e) {
    res.status(500).end();
  }
});

/* --------- Authentification --------- */

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = db.sessions[t];
  if (!s || (s.userId !== 'admin' && !getUser(s.userId))) {
    return res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  }
  if (s.userId !== 'admin') {
    const bu = getUser(s.userId);
    if (banInfo(bu)) return res.status(401).json({ error: banMessage(bu) });
  }
  req.token = t;
  req.userId = s.userId;
  req.isAdmin = s.userId === 'admin'; // administrateur suprême
  req.isStaff = req.isAdmin || !!(getUser(s.userId) && getUser(s.userId).admin);
  next();
}

function adminOnly(req, res, next) {
  if (!req.isStaff) return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
  next();
}

function supremeOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Réservé à l\'administrateur suprême.' });
  next();
}

app.post('/api/login', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans quelques minutes.' });
  const pseudo = cleanPseudo(req.body.pseudo);
  const pin = String(req.body.pin || '');
  if (!pseudo) return res.status(400).json({ error: 'Le pseudo doit faire entre 2 et 20 caractères.' });
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Le code PIN doit contenir exactement 4 chiffres.' });
  if (RESERVED.includes(pseudo.toLowerCase())) return res.status(400).json({ error: 'Ce pseudo est réservé.' });

  let user = findByPseudo(pseudo);
  let created = false;
  if (user) {
    if (user.pin !== pin) {
      return res.status(401).json({ error: 'Ce pseudo existe déjà avec un autre code PIN.' });
    }
    if (banInfo(user)) return res.status(403).json({ error: banMessage(user) });
  } else {
    user = {
      id: uid(),
      pseudo,
      pin,
      avatar: '',
      shareCode: newShareCode(),
      contacts: [],
      appearance: null,
      nickname: '',
      aliases: {},
      addedAt: {},
      warnings: 0,
      createdAt: Date.now(),
    };
    db.users.push(user);
    created = true;
    io.to('staff').emit('contacts:update');
  }
  const token = newToken();
  db.sessions[token] = { userId: user.id, createdAt: Date.now() };
  saveDb();
  res.json({ token, me: meFull(user.id), created });
});

app.post('/api/admin/login', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans quelques minutes.' });
  if (String(req.body.pin || '') !== getAdminPin()) {
    return res.status(401).json({ error: 'Code administrateur incorrect.' });
  }
  const token = newToken();
  db.sessions[token] = { userId: 'admin', createdAt: Date.now() };
  saveDb();
  res.json({ token, me: meFull('admin'), created: false });
});

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.token];
  saveDb();
  res.json({ ok: true });
});

/* --------- Réglages du compte (utilisateurs ET administrateur) --------- */

app.get('/api/me', auth, (req, res) => res.json(meFull(req.userId)));

app.put('/api/me', auth, (req, res) => {
  try {
    return updateMe(req, res);
  } catch (e) {
    console.error('Réglages :', e);
    return res.status(500).json({ error: 'Erreur du serveur, réessaie.' });
  }
});

function updateMe(req, res) {
  const { nickname, avatar: rawAvatar, pin, appearance, description, isPublic } = req.body || {};
  const avatar = normalizeAvatar(rawAvatar);
  const user = req.isAdmin ? null : getUser(req.userId);
  let newNick;
  let newPin = null;
  let newAppearance = null;

  // 1) validation (rien n'est modifié si une valeur est incorrecte)
  if (appearance !== undefined) {
    if (!appearance || !THEMES.includes(appearance.theme) || !ACCENTS.includes(appearance.accent)) {
      return res.status(400).json({ error: 'Apparence invalide.' });
    }
    newAppearance = { theme: appearance.theme, accent: appearance.accent };
  }
  if (avatar !== undefined && !validAvatar(avatar)) {
    return res.status(400).json({ error: 'Photo de profil invalide (URL http(s) ou image).' });
  }
  if (!req.isAdmin && nickname !== undefined) {
    const n = String(nickname || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    if (n && RESERVED.includes(n.toLowerCase())) return res.status(400).json({ error: 'Ce surnom est réservé.' });
    newNick = n;
  }
  if (pin !== undefined && pin !== '') {
    const code = String(pin);
    if (req.isAdmin) {
      if (code.length < 4 || code.length > 40) {
        return res.status(400).json({ error: 'Le code administrateur doit faire entre 4 et 40 caractères.' });
      }
    } else if (!PIN_RE.test(code)) {
      return res.status(400).json({ error: 'Le code PIN doit contenir exactement 4 chiffres.' });
    }
    newPin = code;
  }

  // 2) application
  const target = req.isAdmin ? db.admin : user;
  let visible = false;
  if (newAppearance) target.appearance = newAppearance;
  if (req.isAdmin && description !== undefined) {
    const d = String(description || '').trim().slice(0, 300);
    if (d !== (db.admin.description || '')) { db.admin.description = d; visible = true; }
  }
  if (avatar !== undefined && avatar !== (target.avatar || '')) {
    target.avatar = avatar;
    visible = true;
  }
  if (newNick !== undefined && newNick !== (user.nickname || '')) {
    user.nickname = newNick;
    visible = true;
  }
  if (!req.isAdmin && isPublic !== undefined && !!isPublic !== !!user.isPublic) {
    user.isPublic = !!isPublic;
  }
  if (newPin) {
    if (req.isAdmin) {
      db.admin.pin = newPin;
      // on déconnecte les autres appareils de l'admin
      for (const t of Object.keys(db.sessions)) {
        if (db.sessions[t].userId === 'admin' && t !== req.token) delete db.sessions[t];
      }
    } else {
      user.pin = newPin;
    }
  }
  saveDb();
  if (visible) io.emit('contacts:update');
  res.json(meFull(req.userId));
}

app.post('/api/me/reset-code', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible pour l\'administrateur.' });
  const user = getUser(req.userId);
  user.shareCode = newShareCode(); // l'ancien code est définitivement invalidé
  saveDb();
  io.to('staff').emit('contacts:update');
  res.json({ shareCode: user.shareCode });
});

/* --------- Contacts --------- */

app.get('/api/contacts', auth, (req, res) => res.json(contactListFor(req.userId)));

app.put('/api/contacts/:id/pin', auth, (req, res) => {
  const id = String(req.params.id);
  const value = !!(req.body && req.body.value);
  let holder;
  if (req.userId === 'admin') holder = db.admin;
  else holder = getUser(req.userId);
  if (!holder) return res.status(404).json({ error: 'Compte introuvable.' });
  let list = Array.isArray(holder.pinned) ? holder.pinned.filter((x) => x !== id) : [];
  if (value) {
    if (!contactListFor(req.userId).some((c) => c.id === id)) return res.status(404).json({ error: 'Conversation introuvable.' });
    list.push(id);
  }
  holder.pinned = list.slice(-200);
  saveDb();
  res.json({ ok: true, pinned: value });
});

app.post('/api/contacts', auth, (req, res) => {
  if (req.isAdmin) return res.status(400).json({ error: 'L\'administrateur voit déjà tout le monde.' });
  const code = String(req.body.code || '').trim();
  if (!PIN_RE.test(code)) return res.status(400).json({ error: 'Le code de partage contient 4 chiffres.' });
  const me = getUser(req.userId);
  const target = db.users.find((u) => u.shareCode === code);
  if (!target) return res.status(404).json({ error: 'Aucun utilisateur avec ce code de partage.' });
  if (target.id === me.id) return res.status(400).json({ error: 'Tu ne peux pas t\'ajouter toi-même.' });
  if (me.contacts.includes(target.id)) return res.status(400).json({ error: 'Cet utilisateur est déjà dans tes contacts.' });
  me.contacts.push(target.id);
  if (!target.contacts.includes(me.id)) target.contacts.push(me.id);
  const now = Date.now();
  me.addedAt = me.addedAt || {};
  target.addedAt = target.addedAt || {};
  me.addedAt[target.id] = now;
  target.addedAt[me.id] = now;
  saveDb();
  io.to(me.id).to(target.id).emit('contacts:update');
  res.json(publicUser(target));
});

/* --------- Comptes publics --------- */

function linkContacts(me, target) {
  me.contacts.push(target.id);
  if (!target.contacts.includes(me.id)) target.contacts.push(me.id);
  const now = Date.now();
  me.addedAt = me.addedAt || {};
  target.addedAt = target.addedAt || {};
  me.addedAt[target.id] = now;
  target.addedAt[me.id] = now;
}

// Liste des comptes publics (les comptes privés n'y apparaissent jamais).
// Tout le monde peut la consulter, y compris un compte privé.
app.get('/api/public-users', auth, (req, res) => {
  if (req.isAdmin) return res.json([]);
  const me = getUser(req.userId);
  res.json(
    db.users
      .filter((u) => u.isPublic && u.id !== me.id && !me.contacts.includes(u.id) && !banInfo(u))
      .sort((a, b) => (a.nickname || a.pseudo).localeCompare(b.nickname || b.pseudo, 'fr'))
      .map((u) => ({ id: u.id, pseudo: u.pseudo, name: u.nickname || u.pseudo, avatar: u.avatar || '', online: isOnline(u.id) }))
  );
});

app.post('/api/contacts/public', auth, (req, res) => {
  if (req.isAdmin) return res.status(400).json({ error: 'L\'administrateur voit déjà tout le monde.' });
  const me = getUser(req.userId);
  const target = getUser(String((req.body && req.body.id) || ''));
  if (!target || !target.isPublic) return res.status(404).json({ error: 'Ce compte n\'est pas public.' });
  if (target.id === me.id) return res.status(400).json({ error: 'Tu ne peux pas t\'ajouter toi-même.' });
  if (me.contacts.includes(target.id)) return res.status(400).json({ error: 'Cet utilisateur est déjà dans tes contacts.' });
  linkContacts(me, target);
  saveDb();
  io.to(me.id).to(target.id).emit('contacts:update');
  res.json(publicUser(target));
});

/* --------- Aides : messages & noms --------- */

function addMessage(from, to, text, image, audio) {
  const msg = { id: uid(), from, to, text, ts: Date.now() };
  if (image) msg.image = image;
  if (audio) msg.audio = audio;
  db.messages.push(msg);
  storage.appendMessage(msg).catch((e) => console.error('Message non enregistré :', e.message));
  saveDb();
  emitMsg('message', msg);
  return msg;
}

function displayName(viewerId, targetId) {
  if (targetId === 'admin') return 'Administrateur';
  if (targetId === 'system') return 'Système';
  const t = getUser(targetId);
  if (!t) return 'Compte supprimé';
  const v = viewerId === 'admin' ? null : getUser(viewerId);
  return (v && v.aliases && v.aliases[targetId]) || t.nickname || t.pseudo;
}

/* --------- Surnom local, suppression de contact, signalement --------- */

app.put('/api/contacts/:id/alias', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible.' });
  const me = getUser(req.userId);
  const id = req.params.id;
  if (!me.contacts.includes(id)) return res.status(404).json({ error: 'Contact introuvable.' });
  const alias = String((req.body && req.body.alias) || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  me.aliases = me.aliases || {};
  if (alias) me.aliases[id] = alias; else delete me.aliases[id];
  saveDb();
  res.json({ alias });
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible.' });
  const me = getUser(req.userId);
  const id = req.params.id;
  const other = getUser(id);
  if (!other || !me.contacts.includes(id)) return res.status(404).json({ error: 'Contact introuvable.' });
  me.contacts = me.contacts.filter((c) => c !== id);
  other.contacts = other.contacts.filter((c) => c !== me.id);
  if (me.aliases) delete me.aliases[id];
  if (me.addedAt) delete me.addedAt[id];
  if (other.aliases) delete other.aliases[me.id];
  if (other.addedAt) delete other.addedAt[me.id];
  saveDb();
  io.to(me.id).to(id).emit('contacts:update');
  io.to(me.id).to(id).emit('stories:update');
  res.json({ ok: true });
});

app.post('/api/contacts/:id/report', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible.' });
  const me = getUser(req.userId);
  const id = req.params.id;
  if (!getUser(id) || !me.contacts.includes(id)) return res.status(404).json({ error: 'Contact introuvable.' });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'Explique brièvement la raison du signalement.' });
  if (db.reports.some((r) => r.reporterId === me.id && r.targetId === id && r.status === 'open')) {
    return res.status(409).json({ error: 'Tu as déjà signalé cette personne, l\'administrateur va traiter ta demande.' });
  }
  db.reports.push({ id: uid(), reporterId: me.id, targetId: id, reason, ts: Date.now(), status: 'open' });
  saveDb();
  io.to('staff').emit('reports:update');
  res.json({ ok: true });
});

/* --------- Messages & photos --------- */

app.get('/api/messages/:id', auth, (req, res) => {
  const other = req.params.id;
  if (!canChat(req.userId, other)) return res.status(403).json({ error: 'Conversation non autorisée.' });
  const me = req.userId;
  const list = (isGroupId(other)
    ? db.messages.filter((m) => m.to === other)
    : db.messages.filter((m) => (m.from === me && m.to === other) || (m.from === other && m.to === me))
  ).slice(-500);
  res.json(list);
});

app.put('/api/messages/:mid', auth, async (req, res) => {
  const m = db.messages.find((x) => x.id === req.params.mid);
  if (!m || m.from !== req.userId) return res.status(404).json({ error: 'Message introuvable.' });
  if (m.audio) return res.status(400).json({ error: 'Un vocal ne peut pas être modifié.' });
  if (Date.now() - m.ts > 15 * 60 * 1000) return res.status(403).json({ error: 'Tu ne peux plus modifier ce message (15 minutes maximum).' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text && !m.image) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
  if (text === m.text) return res.json(m);
  m.text = text;
  m.edited = true;
  saveDb();
  try { await storage.updateMessage(m); } catch (e) { console.error('Modification non enregistrée :', e.message); }
  emitMsg('message:edited', m);
  res.json(m);
});

app.delete('/api/messages/:mid', auth, async (req, res) => {
  const i = db.messages.findIndex((x) => x.id === req.params.mid && x.from === req.userId);
  if (i === -1) return res.status(404).json({ error: 'Message introuvable.' });
  const [m] = db.messages.splice(i, 1);
  saveDb();
  try {
    await storage.deleteMessage(m.id);
    if (m.image) await storage.delFile(m.image.split('/').pop());
    if (m.audio) await storage.delFile(m.audio.split('/').pop());
  } catch (e) { console.error('Suppression :', e.message); }
  emitMsg('message:deleted', m, { id: m.id, from: m.from, to: m.to });
  res.json({ ok: true });
});

app.post('/api/upload', auth, async (req, res) => {
  const data = String((req.body && req.body.data) || '');
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return res.status(400).json({ error: 'Image invalide.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Image trop lourde (6 Mo max).' });
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  try {
    await storage.putFile(name, buf);
    res.json({ url: '/uploads/' + name });
  } catch (e) {
    console.error('Upload :', e.message);
    res.status(500).json({ error: 'Impossible d\'enregistrer l\'image.' });
  }
});

/* --------- Galerie photo personnelle (appareil photo) --------- */

const GALLERY_MAX = 300;

app.get('/api/gallery', auth, (req, res) => {
  const u = req.isAdmin ? null : getUser(req.userId);
  res.json(u ? (u.gallery || []).slice().sort((a, b) => b.ts - a.ts) : []);
});

app.post('/api/gallery', auth, async (req, res) => {
  const u = req.isAdmin ? null : getUser(req.userId);
  if (!u) return res.status(403).json({ error: 'Non disponible pour l\'administrateur.' });
  if (!Array.isArray(u.gallery)) u.gallery = [];
  if (u.gallery.length >= GALLERY_MAX) return res.status(400).json({ error: 'Galerie pleine (' + GALLERY_MAX + ' photos max). Supprime-en quelques-unes.' });
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
  if (!m) return res.status(400).json({ error: 'Image invalide.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Image trop lourde (6 Mo max).' });
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  try {
    await storage.putFile(name, buf);
  } catch (e) {
    console.error('Galerie :', e.message);
    return res.status(500).json({ error: 'Impossible d\'enregistrer la photo.' });
  }
  const item = { id: uid(), url: '/uploads/' + name, ts: Date.now() };
  u.gallery.push(item);
  saveDb();
  res.json(item);
});

app.delete('/api/gallery/:id', auth, async (req, res) => {
  const u = req.isAdmin ? null : getUser(req.userId);
  const i = u && Array.isArray(u.gallery) ? u.gallery.findIndex((g) => g.id === req.params.id) : -1;
  if (i === -1) return res.status(404).json({ error: 'Photo introuvable.' });
  const [g] = u.gallery.splice(i, 1);
  saveDb();
  try { await storage.delFile(g.url.split('/').pop()); } catch (e) { /* ignore */ }
  res.json({ ok: true });
});

/* --------- Bans (suspensions avec durée) --------- */

const PERM_BAN = 32503680000000; // an 3000 = définitif

function banInfo(u) {
  if (!u || !u.bannedUntil) return 0;
  if (u.bannedUntil <= Date.now()) { u.bannedUntil = 0; saveDb(); return 0; }
  return u.bannedUntil;
}

function plural(n, a, b) { return n + ' ' + (n > 1 ? b : a); }

function banMessage(u) {
  if (u.bannedUntil >= PERM_BAN) return 'Ton compte a été suspendu définitivement.';
  const mins = Math.max(1, Math.ceil((u.bannedUntil - Date.now()) / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const parts = [];
  if (d) parts.push(plural(d, 'jour', 'jours'));
  if (h) parts.push(plural(h, 'heure', 'heures'));
  if (m) parts.push(plural(m, 'minute', 'minutes'));
  return 'Ton compte a été suspendu. Tu pourras retourner sur ton compte dans ' + parts.slice(0, 2).join(' et ') + '.';
}

function warnUser(userId, text) {
  const t = getUser(userId);
  const msg = String(text || '').trim().slice(0, 2000);
  if (!t || !msg) return;
  t.warnings = (t.warnings || 0) + 1;
  addMessage('system', t.id, '⚠️ ' + msg);
}

/* --------- Chaînes --------- */

const VID_RE = /^\/uploads\/[a-f0-9]{24}\.(mp4|webm|mov)$/;
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

function chanFiles(c) {
  const list = [c.avatar];
  c.posts.forEach((p) => list.push(p.image, p.video, p.audio));
  return list.filter((x) => x && x.startsWith('/uploads/')).map((x) => x.split('/').pop());
}

function chanPublic(c, viewerId) {
  return {
    id: c.id,
    name: c.name,
    description: c.description || '',
    avatar: c.avatar || '',
    subscribers: c.subscribers.length,
    subscribed: c.subscribers.includes(viewerId),
    mine: c.ownerId === viewerId,
    posts: c.posts.length,
    lastTs: c.posts.length ? c.posts[c.posts.length - 1].ts : c.createdAt,
  };
}

function readChanInput(body) {
  const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ');
  const description = String((body && body.description) || '').trim().slice(0, 300);
  const avatar = String((body && body.avatar) || '');
  if (name.length < 2 || name.length > 40) return { error: 'Le nom de la chaîne doit faire entre 2 et 40 caractères.' };
  if (avatar && !IMG_RE.test(avatar)) return { error: 'Photo de chaîne invalide.' };
  return { name, description, avatar };
}

async function dropChannel(c) {
  db.channels = db.channels.filter((x) => x.id !== c.id);
  saveDb();
  for (const n of chanFiles(c)) { try { await storage.delFile(n); } catch (e) { /* ignore */ } }
  io.emit('channels:update');
}

app.get('/api/channels', auth, (req, res) => {
  res.json(db.channels.map((c) => chanPublic(c, req.userId)).sort((a, b) => b.subscribers - a.subscribers || b.lastTs - a.lastTs));
});

app.post('/api/channels', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible pour l\'administrateur.' });
  const u = getUser(req.userId);
  if (u.channelBan) return res.status(403).json({ error: 'L\'administrateur t\'a interdit de créer des chaînes.' });
  if (db.channels.filter((c) => c.ownerId === u.id).length >= 3) return res.status(400).json({ error: 'Tu peux créer 3 chaînes maximum.' });
  const v = readChanInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (db.channels.some((c) => c.name.toLowerCase() === v.name.toLowerCase())) return res.status(409).json({ error: 'Ce nom de chaîne est déjà pris.' });
  const c = { id: uid(), ownerId: u.id, name: v.name, description: v.description, avatar: v.avatar, createdAt: Date.now(), subscribers: [u.id], posts: [] };
  db.channels.push(c);
  saveDb();
  io.emit('channels:update');
  res.json(chanPublic(c, u.id));
});

app.put('/api/channels/:id', auth, (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id && x.ownerId === req.userId);
  if (!c) return res.status(404).json({ error: 'Chaîne introuvable.' });
  const v = readChanInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (db.channels.some((x) => x.id !== c.id && x.name.toLowerCase() === v.name.toLowerCase())) return res.status(409).json({ error: 'Ce nom de chaîne est déjà pris.' });
  if (c.avatar && c.avatar !== v.avatar) storage.delFile(c.avatar.split('/').pop()).catch(() => {});
  c.name = v.name; c.description = v.description; c.avatar = v.avatar;
  saveDb();
  io.emit('channels:update');
  res.json(chanPublic(c, req.userId));
});

app.delete('/api/channels/:id', auth, async (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id && x.ownerId === req.userId);
  if (!c) return res.status(404).json({ error: 'Chaîne introuvable.' });
  await dropChannel(c);
  res.json({ ok: true });
});

app.post('/api/channels/:id/follow', auth, (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id);
  if (!c || req.isAdmin) return res.status(404).json({ error: 'Chaîne introuvable.' });
  if (c.ownerId === req.userId) return res.status(400).json({ error: 'Tu es le créateur de cette chaîne.' });
  const i = c.subscribers.indexOf(req.userId);
  if (i === -1) c.subscribers.push(req.userId); else c.subscribers.splice(i, 1);
  saveDb();
  io.emit('channels:update');
  res.json({ subscribed: i === -1, subscribers: c.subscribers.length });
});

app.get('/api/channels/:id/posts', auth, (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Chaîne introuvable.' });
  res.json({ channel: chanPublic(c, req.userId), posts: c.posts.slice(-200) });
});

app.post('/api/channels/:id/posts', auth, (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id && x.ownerId === req.userId);
  if (!c) return res.status(404).json({ error: 'Chaîne introuvable.' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  const image = String((req.body && req.body.image) || '');
  const video = String((req.body && req.body.video) || '');
  const audio = String((req.body && req.body.audio) || '');
  if (audio && !AUD_RE.test(audio)) return res.status(400).json({ error: 'Vocal invalide.' });
  if (image && !IMG_RE.test(image)) return res.status(400).json({ error: 'Image invalide.' });
  if (video && !VID_RE.test(video)) return res.status(400).json({ error: 'Vidéo invalide.' });
  if (!text && !image && !video && !audio) return res.status(400).json({ error: 'Publication vide.' });
  const post = { id: uid(), text, ts: Date.now() };
  if (image) post.image = image;
  if (video) post.video = video;
  if (audio) post.audio = audio;
  c.posts.push(post);
  saveDb();
  io.emit('channels:update');
  res.json(post);
});

app.delete('/api/channels/:id/posts/:pid', auth, async (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id && x.ownerId === req.userId);
  const i = c ? c.posts.findIndex((p) => p.id === req.params.pid) : -1;
  if (i === -1) return res.status(404).json({ error: 'Publication introuvable.' });
  const [p] = c.posts.splice(i, 1);
  saveDb();
  for (const f of [p.image, p.video, p.audio]) { if (f) { try { await storage.delFile(f.split('/').pop()); } catch (e) { /* ignore */ } } }
  io.emit('channels:update');
  res.json({ ok: true });
});

app.post('/api/upload-video', auth, express.raw({ type: Object.keys(VIDEO_EXT), limit: '30mb' }), async (req, res) => {
  if (req.isAdmin || !db.channels.some((c) => c.ownerId === req.userId)) return res.status(403).json({ error: 'Crée d\'abord une chaîne pour publier des vidéos.' });
  const ext = VIDEO_EXT[String(req.headers['content-type'] || '').split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Vidéo invalide (MP4, WebM ou MOV, 30 Mo max).' });
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  try {
    await storage.putFile(name, req.body);
    res.json({ url: '/uploads/' + name });
  } catch (e) {
    console.error('Upload vidéo :', e.message);
    res.status(500).json({ error: 'Impossible d\'enregistrer la vidéo.' });
  }
});

const AUDIO_EXT = { 'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg' };
const AUD_RE = /^\/uploads\/[a-f0-9]{24}\.(weba|m4a|ogg)$/;

app.post('/api/upload-audio', auth, express.raw({ type: Object.keys(AUDIO_EXT), limit: '15mb' }), async (req, res) => {
  const ext = AUDIO_EXT[String(req.headers['content-type'] || '').split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Vocal invalide.' });
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  try {
    await storage.putFile(name, req.body);
    res.json({ url: '/uploads/' + name });
  } catch (e) {
    console.error('Upload vocal :', e.message);
    res.status(500).json({ error: 'Impossible d\'enregistrer le vocal.' });
  }
});

/* --------- Stories (visibles 24 h) --------- */

const STORY_TTL = 24 * 3600 * 1000;
const IMG_RE = /^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/;

function canSeeStory(viewerId, s) {
  if (s.userId === viewerId) return true;
  const v = getUser(viewerId);
  return !!v && !!getUser(s.userId) && v.contacts.includes(s.userId);
}

function storyView(s, viewerId) {
  const mine = s.userId === viewerId;
  const o = {
    id: s.id,
    userId: s.userId,
    authorName: displayName(viewerId, s.userId),
    image: s.image,
    text: s.text || '',
    ts: s.ts,
    likes: s.likes.length,
    liked: s.likes.includes(viewerId),
    seen: mine || !!s.views[viewerId],
    mine,
    viewsCount: Object.keys(s.views).length,
  };
  if (mine) {
    o.viewers = Object.entries(s.views)
      .filter(([u]) => getUser(u))
      .map(([u, ts]) => ({ id: u, name: displayName(viewerId, u), ts, liked: s.likes.includes(u) }));
  }
  return o;
}

function notifyStory(ownerId) {
  const o = getUser(ownerId);
  [ownerId, ...(o ? o.contacts : [])].forEach((r) => io.to(r).emit('stories:update'));
}

async function purgeStories() {
  const lim = Date.now() - STORY_TTL;
  const old = db.stories.filter((s) => s.ts < lim);
  if (!old.length) return;
  db.stories = db.stories.filter((s) => s.ts >= lim);
  saveDb();
  for (const s of old) { try { await storage.delFile(s.image.split('/').pop()); } catch (e) { /* ignore */ } }
  io.emit('stories:update');
}

app.get('/api/stories', auth, (req, res) => {
  if (req.isAdmin) return res.json([]);
  const lim = Date.now() - STORY_TTL;
  res.json(
    db.stories
      .filter((s) => s.ts >= lim && canSeeStory(req.userId, s))
      .sort((a, b) => a.ts - b.ts)
      .map((s) => storyView(s, req.userId))
  );
});

app.post('/api/stories', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible pour l\'administrateur.' });
  const image = String((req.body && req.body.image) || '');
  if (!IMG_RE.test(image)) return res.status(400).json({ error: 'Image invalide.' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
  const s = { id: uid(), userId: req.userId, image, text, ts: Date.now(), views: {}, likes: [] };
  db.stories.push(s);
  saveDb();
  notifyStory(req.userId);
  res.json(storyView(s, req.userId));
});

app.delete('/api/stories/:id', auth, async (req, res) => {
  const i = db.stories.findIndex((x) => x.id === req.params.id && x.userId === req.userId);
  if (i === -1) return res.status(404).json({ error: 'Story introuvable.' });
  const [s] = db.stories.splice(i, 1);
  saveDb();
  try { await storage.delFile(s.image.split('/').pop()); } catch (e) { /* ignore */ }
  notifyStory(req.userId);
  res.json({ ok: true });
});

app.post('/api/stories/:id/view', auth, (req, res) => {
  const s = db.stories.find((x) => x.id === req.params.id);
  if (!s || !canSeeStory(req.userId, s)) return res.status(404).json({ error: 'Story introuvable.' });
  if (s.userId !== req.userId && !s.views[req.userId]) {
    s.views[req.userId] = Date.now();
    saveDb();
    io.to(s.userId).emit('stories:update');
  }
  res.json({ ok: true });
});

app.post('/api/stories/:id/like', auth, (req, res) => {
  const s = db.stories.find((x) => x.id === req.params.id);
  if (!s || !canSeeStory(req.userId, s) || s.userId === req.userId) return res.status(404).json({ error: 'Story introuvable.' });
  const i = s.likes.indexOf(req.userId);
  if (i === -1) { s.likes.push(req.userId); s.views[req.userId] = s.views[req.userId] || Date.now(); } else s.likes.splice(i, 1);
  saveDb();
  io.to(s.userId).emit('stories:update');
  res.json({ liked: i === -1, likes: s.likes.length });
});

/* --------- Appels vocaux (WebRTC, signalisation par socket.io) --------- */

app.get('/api/ice', auth, (req, res) => {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  }
  res.json(servers);
});

app.get('/api/calls', auth, (req, res) => {
  const me = req.userId;
  res.json(
    db.calls
      .filter((c) => c.from === me || c.to === me || (c.members || []).includes(me))
      .slice(-100)
      .reverse()
      .map((c) => {
        const isGroup = !!c.group;
        const other = isGroup ? c.group : c.from === me ? c.to : c.from;
        const g = isGroup ? getGroup(other) : null;
        const u = isGroup ? null : getUser(other);
        const joined = c.joined || [];
        const status = isGroup ? (joined.includes(me) && c.status === 'ended' ? 'ended' : 'missed') : c.status;
        return {
          id: c.id,
          other,
          group: isGroup,
          name: isGroup ? (g ? g.name : 'Groupe supprimé') : displayName(me, other),
          avatar: isGroup ? '' : other === 'admin' ? db.admin.avatar || '' : u ? u.avatar || '' : '',
          outgoing: c.from === me,
          ts: c.ts,
          duration: c.duration,
          status,
          video: !!c.video,
          callable: isGroup ? !!g && g.members.includes(me) : !!u && canChat(me, other),
        };
      })
  );
});

/* ---- Appels voix / vidéo, 1 à 1 ou en groupe (WebRTC maillé : chacun relié à chacun) ---- */

const calls = new Map();   // callId -> appel en cours
const inCall = new Map();  // userId -> callId (dans l'appel, ou en train de sonner)
const CALL_RING_MS = 45000;
const GROUP_MAX = 8;

const avatarOf = (id) => (id === 'admin' ? db.admin.avatar || '' : (getUser(id) || {}).avatar || '');

function peerInfo(viewer, id, c) {
  const m = c.media.get(id) || {};
  return { id, name: displayName(viewer, id), avatar: avatarOf(id), cam: m.cam !== false, mic: m.mic !== false };
}

const callPeople = (c) => new Set([...c.invited, ...c.participants]);

function endCall(callId, reason) {
  const c = calls.get(callId);
  if (!c) return;
  calls.delete(callId);
  clearTimeout(c.timer);
  const everyone = callPeople(c);
  for (const u of everyone) if (inCall.get(u) === callId) inCall.delete(u);
  let status = 'missed';
  let duration = 0;
  if (c.answeredAt) { status = 'ended'; duration = Math.round((Date.now() - c.answeredAt) / 1000); }
  else if (reason === 'declined') status = 'declined';
  db.calls.push({ id: c.id, from: c.initiator, to: c.to, ts: c.ts, duration, status, video: !!c.video, group: c.groupId || '', members: [...c.members], joined: [...c.everJoined] });
  if (db.calls.length > 2000) db.calls = db.calls.slice(-2000);
  saveDb();
  for (const u of c.members) {
    io.to(u).emit('call:ended', { callId, reason });
    io.to(u).emit('calls:update');
  }
}

function leaveCall(userId, reason) {
  const callId = inCall.get(userId);
  const c = callId && calls.get(callId);
  inCall.delete(userId);
  if (!c) return;
  const wasIn = c.participants.delete(userId);
  c.invited.delete(userId);
  c.media.delete(userId);
  io.to(userId).emit('calls:update');
  const left = c.participants.size;
  if (left === 0 || (left === 1 && c.invited.size === 0)) {
    const r = reason === 'offline' ? 'offline' : reason === 'declined' && !wasIn ? 'declined' : 'hangup';
    return endCall(callId, r);
  }
  if (wasIn) for (const p of c.participants) io.to(p).emit('call:peer-left', { callId, id: userId });
}

function ringExpiry(c) {
  if (!calls.has(c.id)) return;
  if (!c.answeredAt) return endCall(c.id, 'missed');
  for (const u of [...c.invited]) {
    c.invited.delete(u);
    if (inCall.get(u) === c.id) inCall.delete(u);
    io.to(u).emit('call:ended', { callId: c.id, reason: 'missed' });
  }
}

/* ---- Groupes ---- */

async function dropGroup(g) {
  db.groups = db.groups.filter((x) => x.id !== g.id);
  const gm = db.messages.filter((m) => m.to === g.id);
  db.messages = db.messages.filter((m) => m.to !== g.id);
  for (const c of [...calls.values()]) if (c.groupId === g.id) endCall(c.id, 'hangup');
  saveDb();
  try {
    await storage.removeMessagesFor(g.id);
    for (const m of gm) for (const f of [m.image, m.audio]) if (f) await storage.delFile(f.split('/').pop());
  } catch (e) { console.error('Nettoyage groupe :', e.message); }
  if (g.avatar && g.avatar.startsWith('/uploads/')) storage.delFile(g.avatar.split('/').pop()).catch(() => {});
  g.members.forEach((m) => io.to(m).emit('contacts:update'));
}

app.post('/api/groups', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Non disponible pour l\'administrateur.' });
  const me = getUser(req.userId);
  const name = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'Le nom du groupe doit faire entre 2 et 30 caractères.' });
  const raw = Array.isArray(req.body && req.body.members) ? req.body.members.map(String) : [];
  const ids = [...new Set(raw)].filter((x) => x !== me.id);
  if (!ids.length) return res.status(400).json({ error: 'Choisis au moins un membre.' });
  if (ids.length + 1 > GROUP_MAX) return res.status(400).json({ error: 'Un groupe peut avoir ' + GROUP_MAX + ' membres maximum.' });
  if (ids.some((x) => !getUser(x) || !me.contacts.includes(x))) return res.status(400).json({ error: 'Tu ne peux ajouter que tes contacts.' });
  if (db.groups.filter((g) => g.ownerId === me.id).length >= 10) return res.status(400).json({ error: 'Tu peux créer 10 groupes maximum.' });
  const g = { id: 'g_' + uid(), name, avatar: '', ownerId: me.id, members: [me.id, ...ids], createdAt: Date.now() };
  db.groups.push(g);
  saveDb();
  g.members.forEach((m) => io.to(m).emit('contacts:update'));
  res.json({ id: g.id, name: g.name });
});

function ownedGroup(req, res) {
  const g = getGroup(req.params.id);
  if (!g || req.isAdmin || !g.members.includes(req.userId)) { res.status(404).json({ error: 'Groupe introuvable.' }); return null; }
  if (g.ownerId !== req.userId) { res.status(403).json({ error: 'Seul le créateur du groupe peut faire ça.' }); return null; }
  return g;
}

app.put('/api/groups/:id', auth, (req, res) => {
  const g = ownedGroup(req, res);
  if (!g) return;
  const body = req.body || {};
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'Le nom du groupe doit faire entre 2 et 30 caractères.' });
    g.name = name;
  }
  if (body.avatar !== undefined) {
    const av = String(body.avatar || '');
    if (av && !IMG_RE.test(av)) return res.status(400).json({ error: 'Photo de groupe invalide.' });
    if (g.avatar && g.avatar !== av && g.avatar.startsWith('/uploads/')) storage.delFile(g.avatar.split('/').pop()).catch(() => {});
    g.avatar = av;
  }
  saveDb();
  g.members.forEach((m) => io.to(m).emit('contacts:update'));
  res.json({ ok: true, name: g.name, avatar: g.avatar || '' });
});

app.post('/api/groups/:id/members', auth, (req, res) => {
  const g = ownedGroup(req, res);
  if (!g) return;
  const me = getUser(req.userId);
  const raw = Array.isArray(req.body && req.body.members) ? req.body.members.map(String) : [];
  const ids = [...new Set(raw)].filter((x) => !g.members.includes(x));
  if (!ids.length) return res.status(400).json({ error: 'Choisis au moins un contact à ajouter.' });
  if (g.members.length + ids.length > GROUP_MAX) return res.status(400).json({ error: 'Un groupe peut avoir ' + GROUP_MAX + ' membres maximum.' });
  if (ids.some((x) => !getUser(x) || !me.contacts.includes(x))) return res.status(400).json({ error: 'Tu ne peux ajouter que tes contacts.' });
  g.members.push(...ids);
  saveDb();
  g.members.forEach((m) => io.to(m).emit('contacts:update'));
  res.json({ ok: true });
});

app.delete('/api/groups/:id/members/:uid', auth, (req, res) => {
  const g = ownedGroup(req, res);
  if (!g) return;
  const target = req.params.uid;
  if (target === req.userId) return res.status(400).json({ error: 'Pour partir, utilise « Quitter le groupe ».' });
  if (!g.members.includes(target)) return res.status(404).json({ error: 'Ce membre n\'est pas dans le groupe.' });
  const cid = inCall.get(target);
  const cc = cid && calls.get(cid);
  if (cc && cc.groupId === g.id) leaveCall(target, 'hangup');
  const before = [...g.members];
  g.members = g.members.filter((x) => x !== target);
  saveDb();
  before.forEach((m) => io.to(m).emit('contacts:update'));
  res.json({ ok: true });
});

app.post('/api/groups/:id/leave', auth, async (req, res) => {
  const g = getGroup(req.params.id);
  if (!g || req.isAdmin || !g.members.includes(req.userId)) return res.status(404).json({ error: 'Groupe introuvable.' });
  const cid = inCall.get(req.userId);
  const cc = cid && calls.get(cid);
  if (cc && cc.groupId === g.id) leaveCall(req.userId, 'hangup');
  const before = [...g.members];
  g.members = g.members.filter((x) => x !== req.userId);
  if (g.ownerId === req.userId && g.members.length) g.ownerId = g.members[0];
  if (g.members.length < 2) await dropGroup(g); else saveDb();
  before.forEach((m) => io.to(m).emit('contacts:update'));
  res.json({ ok: true });
});

app.delete('/api/groups/:id', auth, async (req, res) => {
  const g = getGroup(req.params.id);
  if (!g || g.ownerId !== req.userId) return res.status(404).json({ error: 'Groupe introuvable.' });
  await dropGroup(g);
  res.json({ ok: true });
});

/* --------- Administration --------- */

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  res.json({
    storage: { mode: storage.mode, label: storage.label, warning: storage.mode === 'file' && ephemeralHostSuspected() },
    users: db.users.map((u) => ({
      id: u.id,
      pseudo: u.pseudo,
      nickname: u.nickname || '',
      reports: db.reports.filter((r) => r.targetId === u.id).length,
      bannedUntil: banInfo(u) ? u.bannedUntil : 0,
      channelBan: !!u.channelBan,
      pin: req.isAdmin ? u.pin : '••••',
      admin: !!u.admin,
      shareCode: u.shareCode,
      isPublic: !!u.isPublic,
      avatar: u.avatar || '',
      contacts: u.contacts.length,
      createdAt: u.createdAt,
      online: isOnline(u.id),
    })),
  });
});

async function removeUser(id) {
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  leaveCall(id, 'offline');

  const files = db.messages.filter((m) => m.from === id || m.to === id).flatMap((m) => [m.image, m.audio]).filter(Boolean).map((x) => x.split('/').pop());
  db.stories.filter((s) => s.userId === id).forEach((s) => files.push(s.image.split('/').pop()));
  (db.users[idx].gallery || []).forEach((g) => files.push(g.url.split('/').pop()));
  db.channels.filter((c) => c.ownerId === id).forEach((c) => chanFiles(c).forEach((n) => files.push(n)));
  db.channels = db.channels.filter((c) => c.ownerId !== id);
  db.channels.forEach((c) => { c.subscribers = c.subscribers.filter((x) => x !== id); });

  for (const g of db.groups.slice()) {
    if (!g.members.includes(id)) continue;
    g.members = g.members.filter((x) => x !== id);
    if (g.ownerId === id && g.members.length) g.ownerId = g.members[0];
    if (g.members.length < 2) await dropGroup(g); else g.members.forEach((m) => io.to(m).emit('contacts:update'));
  }

  db.users.splice(idx, 1);
  db.users.forEach((u) => {
    u.contacts = u.contacts.filter((c) => c !== id);
    if (u.aliases) delete u.aliases[id];
    if (u.addedAt) delete u.addedAt[id];
  });
  db.messages = db.messages.filter((m) => m.from !== id && m.to !== id);
  db.stories = db.stories.filter((s) => s.userId !== id);
  db.stories.forEach((s) => { delete s.views[id]; s.likes = s.likes.filter((x) => x !== id); });
  db.reports = db.reports.filter((r) => r.targetId !== id);
  db.banRequests = db.banRequests.filter((q) => q.targetId !== id && q.requesterId !== id);
  db.calls = db.calls.filter((c) => c.from !== id && c.to !== id);
  for (const t of Object.keys(db.sessions)) {
    if (db.sessions[t].userId === id) delete db.sessions[t];
  }
  saveDb();
  try {
    await storage.removeMessagesFor(id);
    for (const n of files) await storage.delFile(n);
  } catch (e) {
    console.error('Nettoyage :', e.message);
  }
  io.to(id).emit('kicked');
  io.in(id).disconnectSockets(true);
  io.emit('contacts:update');
  io.emit('stories:update');
  io.to('staff').emit('reports:update');
  return true;
}

function protectedTarget(req, res, id) {
  const t = getUser(id);
  if (id === req.userId) { res.status(400).json({ error: 'Action impossible sur ton propre compte.' }); return true; }
  if (t && t.admin && !req.isAdmin) { res.status(403).json({ error: 'Seul l\'administrateur suprême peut agir sur un administrateur.' }); return true; }
  return false;
}

app.delete('/api/admin/users/:id', auth, supremeOnly, async (req, res) => {
  if (protectedTarget(req, res, req.params.id)) return;
  const ok = await removeUser(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ ok: true });
});

// Modifier le code de partage (code d'ami) d'un compte : administrateur suprême uniquement
app.post('/api/admin/users/:id/share-code', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const b = req.body || {};
  let code;
  if (b.random || b.code === undefined || String(b.code).trim() === '') {
    try { code = newShareCode(); } catch (e) { return res.status(500).json({ error: e.message }); }
  } else {
    code = String(b.code).trim();
    if (!PIN_RE.test(code)) return res.status(400).json({ error: 'Le code de partage doit contenir exactement 4 chiffres.' });
    if (db.users.some((x) => x.id !== u.id && x.shareCode === code)) return res.status(409).json({ error: 'Ce code est déjà utilisé par un autre compte.' });
  }
  u.shareCode = code; // l'ancien code est invalidé
  saveDb();
  io.to(u.id).emit('contacts:update');
  io.to('staff').emit('contacts:update');
  res.json({ ok: true, shareCode: code });
});

// Modifier le pseudo (nom d'utilisateur choisi à la création) et/ou le surnom : administrateur suprême uniquement
app.put('/api/admin/users/:id/names', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const b = req.body || {};
  let newPseudo;
  let newNick;
  if (b.pseudo !== undefined) {
    const p = cleanPseudo(b.pseudo);
    if (!p) return res.status(400).json({ error: 'Le pseudo doit faire entre 2 et 20 caractères.' });
    if (RESERVED.includes(p.toLowerCase())) return res.status(400).json({ error: 'Ce pseudo est réservé.' });
    const other = findByPseudo(p);
    if (other && other.id !== u.id) return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
    newPseudo = p;
  }
  if (b.nickname !== undefined) {
    const n = String(b.nickname || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    if (n && RESERVED.includes(n.toLowerCase())) return res.status(400).json({ error: 'Ce surnom est réservé.' });
    newNick = n;
  }
  const old = u.pseudo;
  let changed = false;
  if (newPseudo !== undefined && newPseudo !== u.pseudo) {
    u.pseudo = newPseudo;
    changed = true;
    addMessage('system', u.id, '🔔 L\'administrateur a modifié ton pseudo : « ' + old + ' » → « ' + newPseudo + ' ». C\'est ce nouveau pseudo qu\'il faut utiliser pour te connecter (ton code PIN ne change pas).');
  }
  if (newNick !== undefined && newNick !== (u.nickname || '')) { u.nickname = newNick; changed = true; }
  if (changed) {
    saveDb();
    io.emit('contacts:update');
    io.to('staff').emit('reports:update');
  }
  res.json({ ok: true, pseudo: u.pseudo, nickname: u.nickname || '' });
});

// Vue d'ensemble d'un compte (lecture seule) : réservée à l'administrateur suprême
app.get('/api/admin/users/:id/overview', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const now = Date.now();
  let sent = 0;
  let received = 0;
  for (const m of db.messages) {
    if (m.from === u.id) sent++;
    else if (m.to === u.id && m.from !== 'system') received++;
  }
  const person = (c) => ({ id: c.id, pseudo: c.pseudo, nickname: c.nickname || '', avatar: c.avatar || '', online: isOnline(c.id) });
  const label = (x) => (x ? (x.nickname ? x.nickname + ' (' + x.pseudo + ')' : x.pseudo) : 'Compte supprimé');
  res.json({
    user: {
      id: u.id,
      pseudo: u.pseudo,
      nickname: u.nickname || '',
      avatar: u.avatar || '',
      pin: req.isAdmin ? u.pin : '••••',
      shareCode: u.shareCode,
      admin: !!u.admin,
      isPublic: !!u.isPublic,
      bannedUntil: banInfo(u) ? u.bannedUntil : 0,
      channelBan: !!u.channelBan,
      warnings: u.warnings || 0,
      createdAt: u.createdAt,
      online: isOnline(u.id),
    },
    stats: {
      sent,
      received,
      reportsReceived: db.reports.filter((r) => r.targetId === u.id).length,
      reportsSent: db.reports.filter((r) => r.reporterId === u.id).length,
    },
    contacts: u.contacts.map(getUser).filter(Boolean).map(person),
    groups: db.groups.filter((g) => g.members.includes(u.id)).map((g) => ({ id: g.id, name: g.name, members: g.members.length, owner: g.ownerId === u.id })),
    channels: {
      owned: db.channels.filter((c) => c.ownerId === u.id).map((c) => ({ id: c.id, name: c.name, subscribers: c.subscribers.length, posts: c.posts.length })),
      following: db.channels.filter((c) => c.ownerId !== u.id && c.subscribers.includes(u.id)).length,
    },
    stories: db.stories
      .filter((st) => st.userId === u.id && st.ts >= now - STORY_TTL)
      .sort((a, b) => b.ts - a.ts)
      .map((st) => ({ id: st.id, image: st.image, text: st.text || '', ts: st.ts, likes: st.likes.length, views: Object.keys(st.views).length })),
    reports: db.reports
      .filter((r) => r.targetId === u.id)
      .sort((a, b) => b.ts - a.ts)
      .map((r) => ({ id: r.id, reason: r.reason, ts: r.ts, status: r.status, reporterName: label(getUser(r.reporterId)) })),
    bans: db.banLog
      .filter((e) => e.targetId === u.id)
      .sort((a, b) => b.ts - a.ts)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        byName: e.byName,
        requestedBy: e.requestedBy || '',
        reason: e.reason || '',
        permanent: !!e.permanent,
        minutes: e.minutes || 0,
        status: e.endedAt ? 'ended' : (e.until >= PERM_BAN || e.until > now) ? 'active' : 'expired',
        endedAt: e.endedAt || 0,
        endedBy: e.endedBy || '',
      })),
  });
});

/* --------- Vue détaillée d'un compte (administrateur suprême, lecture seule) --------- */

function logAccess(req, u, action) {
  db.accessLog.push({ id: uid(), ts: Date.now(), targetId: u.id, targetPseudo: u.pseudo, action });
  if (db.accessLog.length > 2000) db.accessLog = db.accessLog.slice(-2000);
  saveDb();
}

// Autre extrémité d'un message du point de vue du compte u (null si le message ne le concerne pas)
function convKey(m, u) {
  if (isGroupId(m.to)) {
    const g = getGroup(m.to);
    return g && g.members.includes(u.id) ? m.to : null;
  }
  if (m.from === u.id) return m.to;
  if (m.to === u.id) return m.from;
  return null;
}

function convInfo(u, other) {
  if (isGroupId(other)) {
    const g = getGroup(other);
    return { id: other, group: true, name: g ? g.name : 'Groupe supprimé', avatar: '' };
  }
  const o = getUser(other);
  return { id: other, group: false, name: displayName('admin', other), avatar: o ? o.avatar || '' : other === 'admin' ? db.admin.avatar || '' : '' };
}

app.get('/api/admin/users/:id/deep', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  logAccess(req, u, 'open');

  const convs = new Map();
  const photos = [];
  for (const m of db.messages) {
    const other = convKey(m, u);
    if (!other) continue;
    let c = convs.get(other);
    if (!c) { c = Object.assign(convInfo(u, other), { count: 0, last: null }); convs.set(other, c); }
    c.count++;
    c.last = { text: m.text || '', image: !!m.image, audio: !!m.audio, ts: m.ts, mine: m.from === u.id };
    if (m.image) photos.push({ url: m.image, ts: m.ts, source: m.from === u.id ? 'sent' : 'received', context: c.name });
  }
  for (const st of db.stories) if (st.userId === u.id) photos.push({ url: st.image, ts: st.ts, source: 'story', context: st.text || '' });
  for (const g of u.gallery || []) photos.push({ url: g.url, ts: g.ts, source: 'gallery', context: '' });
  photos.sort((a, b) => b.ts - a.ts);

  const calls = db.calls
    .filter((c) => c.from === u.id || c.to === u.id || (c.members || []).includes(u.id))
    .slice(-100)
    .reverse()
    .map((c) => {
      const isGroup = !!c.group;
      const other = isGroup ? c.group : c.from === u.id ? c.to : c.from;
      const joined = c.joined || [];
      return {
        id: c.id,
        name: convInfo(u, other).name,
        group: isGroup,
        outgoing: c.from === u.id,
        ts: c.ts,
        duration: c.duration,
        status: isGroup ? (joined.includes(u.id) && c.status === 'ended' ? 'ended' : 'missed') : c.status,
        video: !!c.video,
      };
    });

  res.json({
    user: { id: u.id, pseudo: u.pseudo, nickname: u.nickname || '', avatar: u.avatar || '' },
    conversations: [...convs.values()].sort((a, b) => b.last.ts - a.last.ts),
    calls,
    photos: photos.slice(0, 300),
    accessLog: db.accessLog.filter((e) => e.targetId === u.id).slice(-5).reverse().map((e) => ({ ts: e.ts, action: e.action })),
  });
});

app.get('/api/admin/users/:id/deep/conversation/:other', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const other = req.params.other;
  const info = convInfo(u, other);
  const list = db.messages.filter((m) => convKey(m, u) === other).slice(-500);
  logAccess(req, u, 'conversation:' + info.name);
  const nameOf = (id) => (id === u.id ? u.pseudo : displayName('admin', id));
  res.json({
    conversation: info,
    messages: list.map((m) => ({ id: m.id, from: m.from, fromName: nameOf(m.from), mine: m.from === u.id, text: m.text || '', image: m.image || '', audio: m.audio || '', edited: !!m.edited, ts: m.ts })),
  });
});

app.get('/api/admin/reports', auth, adminOnly, (req, res) => {
  const list = db.reports
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .map((r) => {
      const t = getUser(r.targetId);
      const p = getUser(r.reporterId);
      return {
        id: r.id,
        reason: r.reason,
        ts: r.ts,
        status: r.status,
        targetId: r.targetId,
        targetExists: !!t,
        targetPseudo: t ? t.pseudo : 'Compte supprimé',
        targetName: t ? (t.nickname ? t.nickname + ' (' + t.pseudo + ')' : t.pseudo) : 'Compte supprimé',
        reporterName: p ? p.pseudo : 'Compte supprimé',
        total: db.reports.filter((x) => x.targetId === r.targetId).length,
        warnings: t ? t.warnings || 0 : 0,
      };
    });
  res.json({ open: db.reports.filter((r) => r.status === 'open').length, reports: list });
});

app.post('/api/admin/reports/:id/warn', auth, adminOnly, (req, res) => {
  const r = db.reports.find((x) => x.id === req.params.id);
  const t = r && getUser(r.targetId);
  if (!r || !t) return res.status(404).json({ error: 'Signalement ou compte introuvable.' });
  const text =
    String((req.body && req.body.text) || '').trim().slice(0, 2000) ||
    'Attention ' + t.pseudo + ', vous avez été jugé(e) par un signalement. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte. Si vous ne comprenez pas pourquoi, discutez avec l\'Administrateur.';
  t.warnings = (t.warnings || 0) + 1;
  r.status = 'warned';
  r.handledAt = Date.now();
  addMessage('system', t.id, '⚠️ ' + text);
  saveDb();
  io.to('staff').emit('reports:update');
  res.json({ ok: true });
});

app.post('/api/admin/reports/:id/dismiss', auth, adminOnly, (req, res) => {
  const r = db.reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Signalement introuvable.' });
  r.status = 'dismissed';
  r.handledAt = Date.now();
  saveDb();
  io.to('staff').emit('reports:update');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (protectedTarget(req, res, u.id)) return;
  let until;
  if (req.body && req.body.permanent) {
    until = PERM_BAN;
  } else {
    const m = Math.floor(Number(req.body && req.body.minutes));
    if (!(m >= 1 && m <= 5 * 525600)) return res.status(400).json({ error: 'Durée invalide.' });
    until = Date.now() + m * 60000;
  }
  u.bannedUntil = until;
  const qid0 = req.body && req.body.requestId;
  const qr0 = qid0 && db.banRequests.find((x) => x.id === qid0);
  const reqUser = qr0 && getUser(qr0.requesterId);
  const nowTs = Date.now();
  db.banLog.forEach((e) => {
    if (e.targetId === u.id && !e.endedAt && (e.until >= PERM_BAN || e.until > nowTs)) { e.endedAt = nowTs; e.endedBy = 'Remplacé par un nouveau ban'; }
  });
  db.banLog.push({
    id: uid(),
    targetId: u.id,
    targetPseudo: u.pseudo,
    byName: 'Administrateur',
    requestedBy: reqUser ? reqUser.pseudo : (qr0 ? 'Compte supprimé' : ''),
    reason: String((qr0 && qr0.reason) || (req.body && req.body.reason) || '').trim().slice(0, 300),
    ts: nowTs,
    until,
    permanent: until >= PERM_BAN,
    minutes: until >= PERM_BAN ? 0 : Math.round((until - nowTs) / 60000),
    endedAt: 0,
    endedBy: '',
  });
  if (db.banLog.length > 2000) db.banLog = db.banLog.slice(-2000);
  const rid = req.body && req.body.reportId;
  const r = rid && db.reports.find((x) => x.id === rid);
  if (r) { r.status = 'banned'; r.handledAt = Date.now(); }
  const qid = req.body && req.body.requestId;
  const qr = qid && db.banRequests.find((x) => x.id === qid);
  if (qr) {
    qr.status = 'approved';
    qr.handledAt = Date.now();
    const rr = qr.reportId && db.reports.find((x) => x.id === qr.reportId);
    if (rr) { rr.status = 'banned'; rr.handledAt = Date.now(); }
    if (getUser(qr.requesterId)) addMessage('system', qr.requesterId, '✅ Ta demande de bannissement concernant ' + u.pseudo + ' a été acceptée.');
    io.to('admin').emit('requests:update');
  }
  for (const t of Object.keys(db.sessions)) {
    if (db.sessions[t].userId === u.id) delete db.sessions[t];
  }
  leaveCall(u.id, 'offline');
  saveDb();
  io.to(u.id).emit('banned', { message: banMessage(u) });
  io.in(u.id).disconnectSockets(true);
  io.to('staff').emit('reports:update');
  io.emit('contacts:update');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  u.bannedUntil = 0;
  const nowTs = Date.now();
  db.banLog.forEach((e) => {
    if (e.targetId === u.id && !e.endedAt && (e.until >= PERM_BAN || e.until > nowTs)) { e.endedAt = nowTs; e.endedBy = 'Débanni par l\'Administrateur'; }
  });
  saveDb();
  res.json({ ok: true });
});

// Historique des bannissements (supreme + administrateurs nommés)
app.get('/api/admin/ban-log', auth, adminOnly, (req, res) => {
  const now = Date.now();
  const list = db.banLog.slice().sort((a, b) => b.ts - a.ts).map((e) => {
    const t = getUser(e.targetId);
    const status = e.endedAt ? 'ended' : (e.until >= PERM_BAN || e.until > now) ? 'active' : 'expired';
    return {
      id: e.id,
      targetPseudo: t ? t.pseudo : e.targetPseudo,
      targetExists: !!t,
      byName: e.byName,
      requestedBy: e.requestedBy || '',
      reason: e.reason || '',
      ts: e.ts,
      until: e.until,
      permanent: !!e.permanent,
      minutes: e.minutes || 0,
      status,
      endedAt: e.endedAt || 0,
      endedBy: e.endedBy || '',
    };
  });
  res.json({ log: list });
});

// Demandes de bannissement envoyées par les administrateurs nommés à l'administrateur suprême
app.post('/api/admin/ban-requests', auth, adminOnly, (req, res) => {
  if (req.isAdmin) return res.status(400).json({ error: 'Tu peux bannir directement.' });
  const b = req.body || {};
  const t = getUser(b.targetId);
  if (!t) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (t.id === req.userId || t.admin) return res.status(403).json({ error: 'Tu ne peux pas demander le bannissement de cet administrateur.' });
  const reason = String(b.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'Explique la raison de la demande.' });
  const permanent = !!b.permanent;
  let minutes = 0;
  if (!permanent) {
    minutes = Math.floor(Number(b.minutes));
    if (!(minutes >= 1 && minutes <= 5 * 525600)) return res.status(400).json({ error: 'Durée invalide.' });
  }
  if (db.banRequests.some((x) => x.status === 'open' && x.requesterId === req.userId && x.targetId === t.id)) {
    return res.status(409).json({ error: 'Tu as déjà envoyé une demande pour ce compte.' });
  }
  const rid = b.reportId ? String(b.reportId) : '';
  db.banRequests.push({ id: uid(), requesterId: req.userId, targetId: t.id, reason, permanent, minutes, reportId: rid, ts: Date.now(), status: 'open' });
  const rep = rid && db.reports.find((x) => x.id === rid);
  if (rep && rep.status === 'open') { rep.status = 'forwarded'; rep.handledAt = Date.now(); }
  saveDb();
  io.to('admin').emit('requests:update');
  io.to('staff').emit('reports:update');
  res.json({ ok: true });
});

app.get('/api/admin/ban-requests', auth, supremeOnly, (req, res) => {
  const list = db.banRequests.slice().sort((a, b) => b.ts - a.ts).map((q) => {
    const t = getUser(q.targetId);
    const p = getUser(q.requesterId);
    return {
      id: q.id, reason: q.reason, ts: q.ts, status: q.status, permanent: !!q.permanent, minutes: q.minutes || 0, reportId: q.reportId || '',
      targetId: q.targetId, targetExists: !!t, targetPseudo: t ? t.pseudo : 'Compte supprimé',
      targetName: t ? (t.nickname ? t.nickname + ' (' + t.pseudo + ')' : t.pseudo) : 'Compte supprimé',
      requesterName: p ? p.pseudo : 'Compte supprimé',
    };
  });
  res.json({ open: db.banRequests.filter((q) => q.status === 'open').length, requests: list });
});

app.post('/api/admin/ban-requests/:id/refuse', auth, supremeOnly, (req, res) => {
  const q = db.banRequests.find((x) => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Demande introuvable.' });
  q.status = 'refused';
  q.handledAt = Date.now();
  const t = getUser(q.targetId);
  if (getUser(q.requesterId)) addMessage('system', q.requesterId, '❌ Ta demande de bannissement concernant ' + (t ? t.pseudo : 'ce compte') + ' a été refusée.');
  saveDb();
  io.to('admin').emit('requests:update');
  res.json({ ok: true });
});

// Notification « Système » envoyée à tous les comptes
// Les notifications système sont des messages « Système » commençant par 🔔 : on regroupe ceux envoyés ensemble (même texte, même instant)
const BC_PREFIX = '🔔 ';

function broadcastGroups() {
  const list = db.messages.filter((m) => m.from === 'system' && typeof m.text === 'string' && m.text.startsWith(BC_PREFIX)).sort((a, b) => a.ts - b.ts);
  const groups = [];
  for (const m of list) {
    const g = groups.find((x) => x.text === m.text && m.ts - x.ts < 10000);
    if (g) g.msgs.push(m);
    else groups.push({ id: m.id, text: m.text, ts: m.ts, msgs: [m] });
  }
  return groups;
}

app.get('/api/admin/broadcasts', auth, supremeOnly, (req, res) => {
  res.json(broadcastGroups().reverse().map((g) => ({ id: g.id, text: g.text.slice(BC_PREFIX.length), ts: g.ts, recipients: g.msgs.length, edited: g.msgs.some((m) => m.edited) })));
});

app.put('/api/admin/broadcasts/:id', auth, supremeOnly, async (req, res) => {
  const g = broadcastGroups().find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Notification introuvable.' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 1990);
  if (!text) return res.status(400).json({ error: 'Le texte ne peut pas être vide.' });
  for (const m of g.msgs) {
    m.text = BC_PREFIX + text;
    m.edited = true;
    try { await storage.updateMessage(m); } catch (e) { console.error('Modification non enregistrée :', e.message); }
    emitMsg('message:edited', m);
  }
  saveDb();
  res.json({ ok: true, recipients: g.msgs.length });
});

app.delete('/api/admin/broadcasts/:id', auth, supremeOnly, async (req, res) => {
  const g = broadcastGroups().find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Notification introuvable.' });
  const ids = new Set(g.msgs.map((m) => m.id));
  db.messages = db.messages.filter((m) => !ids.has(m.id));
  saveDb();
  for (const m of g.msgs) {
    try { await storage.deleteMessage(m.id); } catch (e) { console.error('Suppression :', e.message); }
    emitMsg('message:deleted', m, { id: m.id, from: m.from, to: m.to });
  }
  res.json({ ok: true, recipients: g.msgs.length });
});

app.post('/api/admin/broadcast', auth, supremeOnly, (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Écris le texte de la notification.' });
  let n = 0;
  for (const u of db.users) { addMessage('system', u.id, '🔔 ' + text); n++; }
  res.json({ ok: true, sent: n });
});

// Nommer / retirer un administrateur (suprême uniquement)
app.post('/api/admin/users/:id/admin', auth, supremeOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  u.admin = !!(req.body && req.body.value);
  saveDb();
  if (u.admin) io.in(u.id).socketsJoin('staff'); else io.in(u.id).socketsLeave('staff');
  io.to(u.id).emit('me:update');
  io.to('staff').emit('contacts:update');
  res.json({ ok: true, admin: u.admin });
});

app.post('/api/admin/users/:id/channel-ban', auth, adminOnly, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  u.channelBan = !!(req.body && req.body.value);
  saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/stories', auth, adminOnly, (req, res) => {
  const lim = Date.now() - STORY_TTL;
  res.json(
    db.stories
      .filter((s) => s.ts >= lim)
      .sort((a, b) => b.ts - a.ts)
      .map((s) => {
        const u = getUser(s.userId);
        return {
          id: s.id, userId: s.userId, image: s.image, text: s.text || '', ts: s.ts,
          authorPseudo: u ? u.pseudo : 'Compte supprimé',
          authorName: u ? (u.nickname ? u.nickname + ' (' + u.pseudo + ')' : u.pseudo) : 'Compte supprimé',
          likes: s.likes.length, views: Object.keys(s.views).length,
        };
      })
  );
});

app.post('/api/admin/stories/:id/delete', auth, adminOnly, async (req, res) => {
  const i = db.stories.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Story introuvable.' });
  const [st] = db.stories.splice(i, 1);
  saveDb();
  try { await storage.delFile(st.image.split('/').pop()); } catch (e) { /* ignore */ }
  notifyStory(st.userId);
  warnUser(st.userId, req.body && req.body.warn);
  res.json({ ok: true });
});

app.get('/api/admin/channels', auth, adminOnly, (req, res) => {
  res.json(
    db.channels
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => {
        const o = getUser(c.ownerId);
        return {
          id: c.id, name: c.name, description: c.description || '', avatar: c.avatar || '', createdAt: c.createdAt,
          subscribers: c.subscribers.length, posts: c.posts.length,
          ownerId: c.ownerId, ownerExists: !!o,
          ownerPseudo: o ? o.pseudo : 'Compte supprimé',
          ownerName: o ? (o.nickname ? o.nickname + ' (' + o.pseudo + ')' : o.pseudo) : 'Compte supprimé',
        };
      })
  );
});

app.post('/api/admin/channels/:id/delete', auth, adminOnly, async (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Chaîne introuvable.' });
  const owner = getUser(c.ownerId);
  if (owner && req.body && req.body.block) owner.channelBan = true;
  await dropChannel(c);
  if (owner) warnUser(owner.id, req.body && req.body.warn);
  res.json({ ok: true });
});

/* ------------------------------ Socket.io ------------------------------ */

io.use((socket, next) => {
  const t = socket.handshake.auth && socket.handshake.auth.token;
  const s = db.sessions[t];
  if (!s || (s.userId !== 'admin' && !getUser(s.userId))) return next(new Error('unauthorized'));
  const bu = s.userId === 'admin' ? null : getUser(s.userId);
  if (bu && banInfo(bu)) return next(new Error('banned:' + banMessage(bu)));
  socket.userId = s.userId;
  next();
});

io.on('connection', (socket) => {
  const id = socket.userId;
  socket.join(id);
  { const su = getUser(id); if (su && su.admin) socket.join('staff'); if (id === 'admin') socket.join('staff'); }

  const n = (online.get(id) || 0) + 1;
  online.set(id, n);
  if (n === 1) io.emit('presence', { id, online: true });
  socket.emit('presence:list', [...online.keys()].filter(isOnline));

  socket.on('message:send', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const to = data && String(data.to || '');
    const text = data && data.text ? String(data.text).trim().slice(0, 2000) : '';
    const image = data && data.image ? String(data.image) : '';
    const audio = data && data.audio ? String(data.audio) : '';
    if (image && !/^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(image)) return reply({ error: 'Image invalide.' });
    if (audio && !AUD_RE.test(audio)) return reply({ error: 'Vocal invalide.' });
    if (!text && !image && !audio) return reply({ error: 'Message vide.' });
    if (to === 'system') return reply({ error: 'Les notifications du Système sont en lecture seule.' });
    if (!canChat(id, to)) return reply({ error: 'Tu ne peux pas écrire à cette personne.' });

    addMessage(id, to, text, image, audio);
    reply({ ok: true });
  });

  socket.on('call:invite', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const to = String((data && data.to) || '');
    const video = !!(data && data.video);
    if (inCall.has(id)) return reply({ error: 'Tu es déjà en appel.' });
    let invitees = [];
    let g = null;
    if (isGroupId(to)) {
      g = getGroup(to);
      if (!g || !g.members.includes(id)) return reply({ error: 'Tu ne peux pas appeler ce groupe.' });
      invitees = g.members.filter((m) => m !== id && isOnline(m) && !inCall.has(m));
      if (!invitees.length) return reply({ error: 'Personne d\'autre n\'est disponible dans ce groupe pour le moment.' });
    } else {
      if (to === 'admin' || to === 'system') return reply({ error: 'Tu ne peux pas appeler ce compte.' });
      if (!canChat(id, to)) return reply({ error: 'Tu ne peux pas appeler cette personne.' });
      if (!isOnline(to)) return reply({ error: 'Cette personne est hors ligne.' });
      if (inCall.has(to)) return reply({ error: 'Ligne occupée.' });
      invitees = [to];
    }
    const c = {
      id: uid(), initiator: id, to, groupId: g ? g.id : '', video, ts: Date.now(), answeredAt: 0,
      participants: new Set([id]), invited: new Set(invitees), members: new Set([id, ...invitees]),
      everJoined: new Set([id]), media: new Map(), timer: null,
    };
    c.timer = setTimeout(() => ringExpiry(c), CALL_RING_MS);
    calls.set(c.id, c);
    inCall.set(id, c.id);
    for (const u of invitees) {
      inCall.set(u, c.id);
      io.to(u).emit('call:incoming', { callId: c.id, from: id, name: displayName(u, id), video, groupName: g ? g.name : '' });
    }
    reply({ ok: true, callId: c.id });
  });

  socket.on('call:accept', (data) => {
    const c = calls.get(data && data.callId);
    if (!c || !c.invited.has(id) || inCall.get(id) !== c.id) return;
    if (c.participants.size >= GROUP_MAX) return;
    c.invited.delete(id);
    const existing = [...c.participants];
    c.participants.add(id);
    c.everJoined.add(id);
    if (!c.answeredAt) c.answeredAt = Date.now();
    socket.emit('call:joined', { callId: c.id, video: c.video, peers: existing.map((p) => peerInfo(id, p, c)) });
    for (const p of existing) io.to(p).emit('call:peer-joined', { callId: c.id, peer: peerInfo(p, id, c) });
  });

  socket.on('call:signal', (data) => {
    const c = calls.get(data && data.callId);
    const to = String((data && data.to) || '');
    if (!c || !c.participants.has(id) || !c.participants.has(to)) return;
    io.to(to).emit('call:signal', { callId: c.id, from: id, data: data.data });
  });

  socket.on('call:media', (data) => {
    const c = calls.get(data && data.callId);
    if (!c || !c.participants.has(id)) return;
    const st = { cam: !!data.cam, mic: !!data.mic };
    c.media.set(id, st);
    for (const p of c.participants) if (p !== id) io.to(p).emit('call:media', { callId: c.id, from: id, cam: st.cam, mic: st.mic });
  });

  socket.on('call:end', (data) => {
    const c = calls.get(data && data.callId);
    if (!c || inCall.get(id) !== c.id) return;
    leaveCall(id, c.participants.has(id) ? 'hangup' : 'declined');
  });

  socket.on('disconnect', () => {
    const left = (online.get(id) || 1) - 1;
    if (left <= 0) {
      online.delete(id);
      leaveCall(id, 'offline');
      io.emit('presence', { id, online: false });
    } else {
      online.set(id, left);
    }
  });
});

/* ------------------------------ Démarrage ------------------------------ */

async function boot() {
  storage = DATABASE_URL ? createPgStorage() : createFileStorage();
  await storage.init();
  const loaded = await storage.load();
  db = normalizeDb(loaded);
  let migrated = 0;
  for (const m of db.messages) {
    if (m.from === 'admin' && /^(⚠️|🔔|✅|❌) /.test(m.text || '')) { m.from = 'system'; migrated++; }
  }
  if (migrated) {
    console.log('Anciennes notifications déplacées vers « Système » :', migrated);
    if (storage.migrateSystem) await storage.migrateSystem();
  }
  pruneSessions();
  scheduleSave(); // crée / migre immédiatement les données
  purgeStories();
  setInterval(purgeStories, 3600 * 1000);

  server.listen(PORT, () => {
    console.log('==============================================');
    console.log(' Tonin Conect est lancé : http://localhost:' + PORT);
    console.log(' Stockage : ' + storage.label);
    console.log(' Comptes : ' + db.users.length + ' | Messages : ' + db.messages.length);
    console.log(' Code administrateur : ' + (db.admin.pin ? 'modifié dans les réglages' : DEFAULT_ADMIN_PIN));
    if (ephemeralHostSuspected()) {
      console.log(' ⚠️  ATTENTION : hébergeur à disque temporaire détecté !');
      console.log('    Tes données seront effacées. Définis DATABASE_URL (PostgreSQL)');
      console.log('    ou DATA_DIR vers un disque persistant.');
    }
    console.log('==============================================');
  });
}

boot().catch((e) => {
  console.error('ERREUR FATALE AU DÉMARRAGE :', e.message);
  process.exit(1);
});