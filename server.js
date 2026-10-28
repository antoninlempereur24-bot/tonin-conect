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
const ACCENTS = ['violet', 'ocean', 'menthe', 'rose', 'orange'];
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

const ICON_URL =
  'https://github.com/antoninlempereur24-bot/tonin-conect/blob/main/pdp%20tonin%20conect.jpg?raw=true';

/* ------------------------- Base de données (mémoire) ------------------------- */

const emptyDb = () => ({
  users: [],
  messages: [],
  sessions: {},
  admin: { pin: '', avatar: '', appearance: null },
  reports: [],
  stories: [],
  calls: [],
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
      'INSERT INTO messages(id, from_id, to_id, text, image, ts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
      [m.id, m.from, m.to, m.text || '', m.image || null, m.ts]
    );

  return {
    mode: 'postgres',
    label: 'Base PostgreSQL (durable)',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
      await pool.query(
        'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT, image TEXT, ts BIGINT NOT NULL)'
      );
      await pool.query('CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts)');
      await pool.query('CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BYTEA NOT NULL)');
    },
    async load() {
      const core = await pool.query("SELECT value FROM kv WHERE key = 'core'");
      const msgs = await pool.query('SELECT id, from_id, to_id, text, image, ts FROM messages ORDER BY ts ASC');
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
        return m;
      });
      return data;
    },
    async saveCore() {
      const core = { users: db.users, sessions: db.sessions, admin: db.admin, reports: db.reports, stories: db.stories, calls: db.calls };
      await pool.query(
        "INSERT INTO kv (key, value) VALUES ('core', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify(core)]
      );
    },
    async appendMessage(m) { await insertMessage(m); },
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

function adminPublic() {
  return { id: 'admin', pseudo: 'Administrateur', nickname: '', name: 'Administrateur', avatar: db.admin.avatar || '', isAdmin: true, online: isOnline('admin') };
}

function publicUser(u) {
  return { id: u.id, pseudo: u.pseudo, nickname: u.nickname || '', name: u.nickname || u.pseudo, avatar: u.avatar || '', isAdmin: false, online: isOnline(u.id) };
}

function meFull(userId) {
  if (userId === 'admin') {
    return {
      id: 'admin',
      pseudo: 'Administrateur',
      nickname: '',
      name: 'Administrateur',
      avatar: db.admin.avatar || '',
      isAdmin: true,
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
    appearance: u.appearance || DEFAULT_APPEARANCE,
  };
}

function canChat(a, b) {
  if (a === b) return false;
  if (a === 'admin') return !!getUser(b);
  if (b === 'admin') return !!getUser(a);
  const ua = getUser(a);
  return !!ua && !!getUser(b) && ua.contacts.includes(b);
}

function contactListFor(userId) {
  const viewer = userId === 'admin' ? null : getUser(userId);
  let list;
  if (!viewer) {
    list = db.users.map(publicUser);
  } else {
    list = viewer.contacts.map(getUser).filter(Boolean).map(publicUser);
    list.unshift(adminPublic());
  }
  const last = {};
  for (const m of db.messages) {
    if (m.from === userId) last[m.to] = m;
    else if (m.to === userId) last[m.from] = m;
  }
  return list.map((c) => {
    const u = c.isAdmin ? null : getUser(c.id);
    const alias = (viewer && viewer.aliases && viewer.aliases[c.id]) || '';
    return {
      ...c,
      name: alias || c.name,
      alias,
      shareCode: u ? u.shareCode : '',
      since: (viewer && viewer.addedAt && viewer.addedAt[c.id]) || null,
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
  if (iconCache) return iconCache;
  if (typeof fetch !== 'function') return null;
  try {
    const r = await fetch(ICON_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const type = sniffImage(buf);
    if (!type) throw new Error('le fichier n\'est pas une image PNG/JPEG');
    iconCache = { buf, type };
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
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(icon.buf);
  }
);

app.get('/manifest.webmanifest', async (q, r) => {
  const icon = await getIcon();
  const type = icon ? icon.type : 'image/png';
  r.type('application/manifest+json').json({
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
      { src: '/icon-192.png', sizes: '192x192', type, purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type, purpose: 'any' },
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
  if (!/^[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(name)) return res.status(404).end();
  try {
    const buf = await storage.getFile(name);
    if (!buf) return res.status(404).end();
    res.set('Content-Type', MIME[name.split('.')[1]]);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
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
  req.token = t;
  req.userId = s.userId;
  req.isAdmin = s.userId === 'admin';
  next();
}

function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
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
    io.to('admin').emit('contacts:update');
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
  const { nickname, avatar: rawAvatar, pin, appearance } = req.body || {};
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
  if (avatar !== undefined && avatar !== (target.avatar || '')) {
    target.avatar = avatar;
    visible = true;
  }
  if (newNick !== undefined && newNick !== (user.nickname || '')) {
    user.nickname = newNick;
    visible = true;
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
  io.to('admin').emit('contacts:update');
  res.json({ shareCode: user.shareCode });
});

/* --------- Contacts --------- */

app.get('/api/contacts', auth, (req, res) => res.json(contactListFor(req.userId)));

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

/* --------- Aides : messages & noms --------- */

function addMessage(from, to, text, image) {
  const msg = { id: uid(), from, to, text, ts: Date.now() };
  if (image) msg.image = image;
  db.messages.push(msg);
  storage.appendMessage(msg).catch((e) => console.error('Message non enregistré :', e.message));
  saveDb();
  io.to(from).to(to).emit('message', msg);
  return msg;
}

function displayName(viewerId, targetId) {
  if (targetId === 'admin') return 'Administrateur';
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
  io.to('admin').emit('reports:update');
  res.json({ ok: true });
});

/* --------- Messages & photos --------- */

app.get('/api/messages/:id', auth, (req, res) => {
  const other = req.params.id;
  if (!canChat(req.userId, other)) return res.status(403).json({ error: 'Conversation non autorisée.' });
  const me = req.userId;
  const list = db.messages
    .filter((m) => (m.from === me && m.to === other) || (m.from === other && m.to === me))
    .slice(-500);
  res.json(list);
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
      .filter((c) => c.from === me || c.to === me)
      .slice(-100)
      .reverse()
      .map((c) => {
        const other = c.from === me ? c.to : c.from;
        const u = getUser(other);
        return {
          id: c.id,
          other,
          name: displayName(me, other),
          avatar: u ? u.avatar || '' : '',
          outgoing: c.from === me,
          ts: c.ts,
          duration: c.duration,
          status: c.status,
          callable: !!u && canChat(me, other),
        };
      })
  );
});

const calls = new Map();   // callId -> appel en cours
const inCall = new Map();  // userId -> callId

function endCall(callId, reason) {
  const c = calls.get(callId);
  if (!c) return;
  calls.delete(callId);
  inCall.delete(c.from);
  inCall.delete(c.to);
  clearTimeout(c.timer);
  let status = 'missed';
  let duration = 0;
  if (c.answeredAt) { status = 'ended'; duration = Math.round((Date.now() - c.answeredAt) / 1000); }
  else if (reason === 'declined') status = 'declined';
  db.calls.push({ id: c.id, from: c.from, to: c.to, ts: c.ts, duration, status });
  if (db.calls.length > 2000) db.calls = db.calls.slice(-2000);
  saveDb();
  io.to(c.from).to(c.to).emit('call:ended', { callId, reason });
  io.to(c.from).to(c.to).emit('calls:update');
}

/* --------- Administration --------- */

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  res.json({
    storage: { mode: storage.mode, label: storage.label, warning: storage.mode === 'file' && ephemeralHostSuspected() },
    users: db.users.map((u) => ({
      id: u.id,
      pseudo: u.pseudo,
      nickname: u.nickname || '',
      reports: db.reports.filter((r) => r.targetId === u.id).length,
      pin: u.pin,
      shareCode: u.shareCode,
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
  const cid = inCall.get(id);
  if (cid) endCall(cid, 'offline');

  const files = db.messages.filter((m) => (m.from === id || m.to === id) && m.image).map((m) => m.image.split('/').pop());
  db.stories.filter((s) => s.userId === id).forEach((s) => files.push(s.image.split('/').pop()));

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
  io.to('admin').emit('reports:update');
  return true;
}

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const ok = await removeUser(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ ok: true });
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
    'Attention ' + t.pseudo + ', vous avez été jugé(e) par un signalement. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte.';
  t.warnings = (t.warnings || 0) + 1;
  r.status = 'warned';
  r.handledAt = Date.now();
  addMessage('admin', t.id, '⚠️ ' + text);
  saveDb();
  io.to('admin').emit('reports:update');
  res.json({ ok: true });
});

app.post('/api/admin/reports/:id/dismiss', auth, adminOnly, (req, res) => {
  const r = db.reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Signalement introuvable.' });
  r.status = 'dismissed';
  r.handledAt = Date.now();
  saveDb();
  io.to('admin').emit('reports:update');
  res.json({ ok: true });
});

/* ------------------------------ Socket.io ------------------------------ */

io.use((socket, next) => {
  const t = socket.handshake.auth && socket.handshake.auth.token;
  const s = db.sessions[t];
  if (!s || (s.userId !== 'admin' && !getUser(s.userId))) return next(new Error('unauthorized'));
  socket.userId = s.userId;
  next();
});

io.on('connection', (socket) => {
  const id = socket.userId;
  socket.join(id);

  const n = (online.get(id) || 0) + 1;
  online.set(id, n);
  if (n === 1) io.emit('presence', { id, online: true });
  socket.emit('presence:list', [...online.keys()].filter(isOnline));

  socket.on('message:send', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const to = data && String(data.to || '');
    const text = data && data.text ? String(data.text).trim().slice(0, 2000) : '';
    const image = data && data.image ? String(data.image) : '';
    if (image && !/^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(image)) return reply({ error: 'Image invalide.' });
    if (!text && !image) return reply({ error: 'Message vide.' });
    if (!canChat(id, to)) return reply({ error: 'Tu ne peux pas écrire à cette personne.' });

    addMessage(id, to, text, image);
    reply({ ok: true });
  });

  socket.on('call:invite', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const to = String((data && data.to) || '');
    if (id === 'admin' || to === 'admin') return reply({ error: 'Appel impossible avec l\'administrateur.' });
    if (!canChat(id, to)) return reply({ error: 'Tu ne peux pas appeler cette personne.' });
    if (!isOnline(to)) return reply({ error: 'Cette personne est hors ligne.' });
    if (inCall.has(id) || inCall.has(to)) return reply({ error: 'Ligne occupée.' });
    const c = { id: uid(), from: id, to, ts: Date.now(), answeredAt: 0 };
    c.timer = setTimeout(() => endCall(c.id, 'missed'), 45000);
    calls.set(c.id, c);
    inCall.set(id, c.id);
    inCall.set(to, c.id);
    io.to(to).emit('call:incoming', { callId: c.id, from: id, name: displayName(to, id) });
    reply({ ok: true, callId: c.id });
  });

  socket.on('call:accept', (data) => {
    const c = calls.get(data && data.callId);
    if (!c || c.to !== id || c.answeredAt) return;
    clearTimeout(c.timer);
    c.answeredAt = Date.now();
    io.to(c.from).emit('call:accepted', { callId: c.id });
  });

  socket.on('call:signal', (data) => {
    const c = calls.get(data && data.callId);
    if (!c || (c.from !== id && c.to !== id)) return;
    io.to(c.from === id ? c.to : c.from).emit('call:signal', { callId: c.id, data: data.data });
  });

  socket.on('call:end', (data) => {
    const c = calls.get(data && data.callId);
    if (!c || (c.from !== id && c.to !== id)) return;
    endCall(c.id, !c.answeredAt && c.to === id ? 'declined' : 'hangup');
  });

  socket.on('disconnect', () => {
    const left = (online.get(id) || 1) - 1;
    if (left <= 0) {
      online.delete(id);
      if (inCall.has(id)) endCall(inCall.get(id), 'offline');
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