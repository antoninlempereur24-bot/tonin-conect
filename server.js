'use strict';

/* ============================================================
   TONIN CONECT - serveur
   - Express (API REST) + Socket.io (temps réel)
   - Persistance dans db.json (créé automatiquement)
   - Compte administrateur : code défini par la variable
     d'environnement ADMIN_PIN (par défaut : 1234)
   ============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = String(process.env.ADMIN_PIN || '137920');
const DB_FILE = path.join(__dirname, 'db.json');
const PIN_RE = /^\d{4}$/;
const RESERVED = ['admin', 'administrateur', 'administrator'];

/* ------------------------- Base de données ------------------------- */

let db = { users: [], messages: [], sessions: {} };

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = {
        users: d.users || [],
        messages: d.messages || [],
        sessions: d.sessions || {},
      };
    }
  } catch (e) {
    console.error('Erreur de lecture de db.json :', e);
  }
}

function flushDb() {
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('Erreur d\'écriture de db.json :', e);
  }
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushDb();
  }, 100);
}

loadDb();
process.on('SIGINT', () => { flushDb(); process.exit(0); });
process.on('SIGTERM', () => { flushDb(); process.exit(0); });

/* ----------------------------- Utilitaires ----------------------------- */

const uid = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function newShareCode() {
  const used = new Set(db.users.map((u) => u.shareCode));
  if (used.size >= 10000) throw new Error('Plus de codes de partage disponibles');
  for (;;) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!used.has(c)) return c;
  }
}

const getUser = (id) => db.users.find((u) => u.id === id);
const findByPseudo = (p) =>
  db.users.find((u) => u.pseudo.toLowerCase() === p.toLowerCase());

function cleanPseudo(x) {
  const p = String(x || '').trim().replace(/\s+/g, ' ');
  return p.length >= 2 && p.length <= 20 ? p : '';
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

function adminPublic() {
  return { id: 'admin', pseudo: 'Administrateur', avatar: '', isAdmin: true, online: isOnline('admin') };
}

function publicUser(u) {
  return { id: u.id, pseudo: u.pseudo, avatar: u.avatar || '', isAdmin: false, online: isOnline(u.id) };
}

function meFull(userId) {
  if (userId === 'admin') return { id: 'admin', pseudo: 'Administrateur', avatar: '', isAdmin: true };
  const u = getUser(userId);
  return {
    id: u.id,
    pseudo: u.pseudo,
    avatar: u.avatar || '',
    pin: u.pin,
    shareCode: u.shareCode,
    isAdmin: false,
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
  let list;
  if (userId === 'admin') {
    list = db.users.map(publicUser);
  } else {
    const me = getUser(userId);
    list = me.contacts.map(getUser).filter(Boolean).map(publicUser);
    list.unshift(adminPublic());
  }
  const last = {};
  for (const m of db.messages) {
    if (m.from === userId) last[m.to] = m;
    else if (m.to === userId) last[m.from] = m;
  }
  return list.map((c) => ({ ...c, last: last[c.id] || null }));
}

/* ------------------------------ Express ------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', true);

// On ne sert QUE les fichiers publics (jamais db.json ni server.js)
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (q, r) => r.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (q, r) => r.sendFile(path.join(__dirname, 'script.js')));

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

/* --------- Connexion / inscription --------- */

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
  if (String(req.body.pin || '') !== ADMIN_PIN) {
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

/* --------- Profil --------- */

app.get('/api/me', auth, (req, res) => res.json(meFull(req.userId)));

app.put('/api/me', auth, (req, res) => {
  if (req.isAdmin) return res.status(403).json({ error: 'Le compte administrateur n\'a pas de profil modifiable.' });
  const user = getUser(req.userId);
  const { pseudo, avatar, pin } = req.body;

  if (pseudo !== undefined) {
    const p = cleanPseudo(pseudo);
    if (!p) return res.status(400).json({ error: 'Le pseudo doit faire entre 2 et 20 caractères.' });
    if (RESERVED.includes(p.toLowerCase())) return res.status(400).json({ error: 'Ce pseudo est réservé.' });
    const other = findByPseudo(p);
    if (other && other.id !== user.id) return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
    user.pseudo = p;
  }
  if (avatar !== undefined) {
    if (!validAvatar(avatar)) return res.status(400).json({ error: 'Photo de profil invalide (URL http(s) ou image).' });
    user.avatar = avatar;
  }
  if (pin !== undefined && pin !== '') {
    if (!PIN_RE.test(String(pin))) return res.status(400).json({ error: 'Le code PIN doit contenir exactement 4 chiffres.' });
    user.pin = String(pin);
  }
  saveDb();
  io.emit('contacts:update');
  res.json(meFull(user.id));
});

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
  saveDb();
  io.to(me.id).to(target.id).emit('contacts:update');
  res.json(publicUser(target));
});

/* --------- Messages --------- */

app.get('/api/messages/:id', auth, (req, res) => {
  const other = req.params.id;
  if (!canChat(req.userId, other)) return res.status(403).json({ error: 'Conversation non autorisée.' });
  const me = req.userId;
  const list = db.messages
    .filter((m) => (m.from === me && m.to === other) || (m.from === other && m.to === me))
    .slice(-500);
  res.json(list);
});

/* --------- Administration --------- */

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  res.json(
    db.users.map((u) => ({
      id: u.id,
      pseudo: u.pseudo,
      pin: u.pin,
      shareCode: u.shareCode,
      avatar: u.avatar || '',
      contacts: u.contacts.length,
      createdAt: u.createdAt,
      online: isOnline(u.id),
    }))
  );
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const id = req.params.id;
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  db.users.splice(idx, 1);
  db.users.forEach((u) => { u.contacts = u.contacts.filter((c) => c !== id); });
  db.messages = db.messages.filter((m) => m.from !== id && m.to !== id);
  for (const t of Object.keys(db.sessions)) {
    if (db.sessions[t].userId === id) delete db.sessions[t];
  }
  saveDb();
  io.to(id).emit('kicked');
  io.in(id).disconnectSockets(true);
  io.emit('contacts:update');
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
    const text = data && String(data.text || '').trim().slice(0, 2000);
    if (!text) return reply({ error: 'Message vide.' });
    if (!canChat(id, to)) return reply({ error: 'Tu ne peux pas écrire à cette personne.' });
    const msg = { id: uid(), from: id, to, text, ts: Date.now() };
    db.messages.push(msg);
    saveDb();
    io.to(id).to(to).emit('message', msg);
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    const left = (online.get(id) || 1) - 1;
    if (left <= 0) {
      online.delete(id);
      io.emit('presence', { id, online: false });
    } else {
      online.set(id, left);
    }
  });
});

/* ------------------------------ Démarrage ------------------------------ */

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(' Tonin Conect est lancé : http://localhost:' + PORT);
  console.log(' Code administrateur : ' + ADMIN_PIN + (process.env.ADMIN_PIN ? '' : '  (par défaut, change-le avec ADMIN_PIN)'));
  console.log('==============================================');
});
