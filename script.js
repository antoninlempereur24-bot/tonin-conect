(() => {
  'use strict';

  /* =====================================================
     TONIN CONECT - client
     ===================================================== */

  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem('tc_token'),
    me: null,
    contacts: [],
    current: null,
    cache: {},          // id contact -> messages[]
    unread: {},         // id contact -> nombre de non lus
    online: new Set(),
    socket: null,
    avatarValue: '',    // avatar en cours d'édition dans les réglages
    unreadInit: false,
    appearance: { theme: 'dark', accent: 'violet' },
  };

  /* ---------------- Apparence (thème + couleur) ---------------- */

  const ACCENTS = {
    violet: ['#7c5cff', '#4da3ff'],
    ocean: ['#2f80ed', '#2dd4bf'],
    menthe: ['#10b981', '#84cc16'],
    rose: ['#ec4899', '#f97316'],
    orange: ['#f59e0b', '#ef4444'],
  };

  function markAppearanceButtons() {
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeChoice === state.appearance.theme);
    });
    document.querySelectorAll('.swatch').forEach((b) => {
      b.classList.toggle('active', b.dataset.accent === state.appearance.accent);
    });
  }

  function applyAppearance(a) {
    const ap = { theme: 'dark', accent: 'violet', ...(a || {}) };
    if (!['dark', 'light'].includes(ap.theme)) ap.theme = 'dark';
    if (!ACCENTS[ap.accent]) ap.accent = 'violet';
    const root = document.documentElement;
    root.dataset.theme = ap.theme;
    root.style.setProperty('--accent', ACCENTS[ap.accent][0]);
    root.style.setProperty('--accent-2', ACCENTS[ap.accent][1]);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = ap.theme === 'light' ? '#f2f4fb' : '#0f1220';
    state.appearance = ap;
    try { localStorage.setItem('tc_appearance', JSON.stringify(ap)); } catch (e) { /* ignore */ }
    markAppearanceButtons();
  }

  function setAppearance(partial) {
    const ap = { ...state.appearance, ...partial };
    applyAppearance(ap);
    if (state.token && state.me) {
      state.me.appearance = ap;
      api('/api/me', 'PUT', { appearance: ap }).catch(() => {});
    }
  }

  // Pastilles de couleur
  Object.keys(ACCENTS).forEach((key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.accent = key;
    b.title = key;
    b.style.background = `linear-gradient(135deg, ${ACCENTS[key][0]}, ${ACCENTS[key][1]})`;
    b.addEventListener('click', () => setAppearance({ accent: key }));
    $('accent-row').appendChild(b);
  });
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    b.addEventListener('click', () => setAppearance({ theme: b.dataset.themeChoice }));
  });

  // Applique tout de suite le dernier thème connu (évite le flash)
  try { applyAppearance(JSON.parse(localStorage.getItem('tc_appearance'))); } catch (e) { applyAppearance(null); }

  /* ---------------- Utilitaires ---------------- */

  // Lien GitHub « blob » => fichier brut (sinon ce n'est pas une image)
  function fixImageUrl(u) {
    u = (u || '').trim();
    if (/^https?:\/\/github\.com\/.+\/blob\//i.test(u) && !/[?&]raw=true/i.test(u)) {
      u += (u.includes('?') ? '&' : '?') + 'raw=true';
    }
    return u;
  }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* pas de JSON */ }
    if (!res.ok) {
      if (res.status === 401 && state.token && path !== '/api/login' && path !== '/api/admin/login') {
        forceLogout(data.error || 'Session expirée, reconnecte-toi.');
      }
      throw new Error(data.error || 'Erreur ' + res.status);
    }
    return data;
  }

  function colorFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return `hsl(${h}, 55%, 45%)`;
  }

  function makeAvatar(user, big = false) {
    const el = document.createElement('div');
    el.className = 'avatar' + (big ? ' big' : '');
    const fallback = () => {
      el.innerHTML = '';
      if (user.isAdmin) {
        el.style.background = 'linear-gradient(135deg,#f5a623,#f76b1c)';
        el.textContent = '👑';
      } else {
        const nm = user.name || user.pseudo || '?';
        el.style.background = colorFor(nm);
        el.textContent = nm.trim().charAt(0).toUpperCase();
      }
    };
    if (user.avatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = user.avatar;
      img.onerror = fallback;
      el.appendChild(img);
    } else {
      fallback();
    }
    return el;
  }

  function avatarWithDot(user) {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-wrap';
    wrap.appendChild(makeAvatar(user));
    if (state.online.has(user.id)) {
      const d = document.createElement('span');
      d.className = 'dot';
      wrap.appendChild(d);
    }
    return wrap;
  }

  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ts) =>
    new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('fr-FR');

  function readMap() {
    try { return JSON.parse(localStorage.getItem('tc_read_' + state.me.id)) || {}; } catch (e) { return {}; }
  }
  function markRead(id) {
    const list = state.cache[id];
    const map = readMap();
    map[id] = list && list.length ? list[list.length - 1].ts : Date.now();
    localStorage.setItem('tc_read_' + state.me.id, JSON.stringify(map));
    state.unread[id] = 0;
  }

  const previewText = (m) =>
    m.image ? (m.text ? '📷 ' + m.text : '📷 Photo') : m.text;

  /* ---------------- Images (redimensionnement) ---------------- */

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image illisible.'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderToDataUrl(img, { max, square, quality }) {
    let sw = img.width, sh = img.height, sx = 0, sy = 0, w, h;
    if (square) {
      const m = Math.min(sw, sh);
      sx = (sw - m) / 2;
      sy = (sh - m) / 2;
      sw = sh = m;
      w = h = max;
    } else {
      const k = Math.min(1, max / Math.max(sw, sh));
      w = Math.round(sw * k);
      h = Math.round(sh * k);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  /* ---------------- Connexion ---------------- */

  const authError = (m) => { $('auth-error').textContent = m || ''; };

  $('toggle-admin').addEventListener('click', () => {
    const adminMode = $('admin-form').classList.toggle('hidden');
    $('login-form').classList.toggle('hidden', !adminMode);
    $('toggle-admin').textContent = adminMode ? 'Compte administrateur' : '← Retour à la connexion';
    authError('');
  });

  $('login-pin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    try {
      const r = await api('/api/login', 'POST', {
        pseudo: $('login-pseudo').value,
        pin: $('login-pin').value,
      });
      await onAuth(r);
    } catch (err) {
      authError(err.message);
    }
  });

  $('admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    try {
      const r = await api('/api/admin/login', 'POST', { pin: $('admin-pin').value });
      await onAuth(r);
    } catch (err) {
      authError(err.message);
    }
  });

  async function onAuth(r) {
    state.token = r.token;
    localStorage.setItem('tc_token', r.token);
    state.me = r.me;
    await startApp();
    if (r.created) toast('Compte créé ! Ton code de partage : ' + r.me.shareCode);
  }

  async function startApp() {
    $('auth-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    applyAppearance(state.me.appearance);
    renderMe();
    connectSocket();
    await loadContacts();
    afterStart();
  }

  function forceLogout(message) {
    localStorage.removeItem('tc_token');
    if (message) sessionStorage.setItem('tc_msg', message);
    location.reload();
  }

  $('btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', 'POST'); } catch (e) { /* ignore */ }
    forceLogout();
  });

  function renderMe() {
    const me = state.me;
    const holder = $('me-avatar');
    holder.innerHTML = '';
    holder.appendChild(makeAvatar(me));
    $('me-name').textContent = me.name || me.pseudo;
    $('me-sub').textContent = me.isAdmin ? 'Compte administrateur' : 'Connecté';
    $('btn-admin').classList.toggle('hidden', !me.isAdmin);
    $('btn-add').classList.toggle('hidden', !!me.isAdmin);
  }

  /* ---------------- Socket.io ---------------- */

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') forceLogout('Session expirée, reconnecte-toi.');
      if (err && /^banned:/.test(err.message)) forceLogout(err.message.slice(7));
    });

    socket.on('kicked', () => forceLogout('Ton compte a été supprimé par l\'administrateur.'));
    bindExtraSocket(socket);

    socket.on('presence:list', (ids) => {
      state.online = new Set(ids);
      renderContacts();
      renderChatHeader();
    });

    socket.on('presence', ({ id, online }) => {
      if (online) state.online.add(id); else state.online.delete(id);
      renderContacts();
      renderChatHeader();
    });

    socket.on('contacts:update', async () => {
      try {
        await loadContacts();
        if (state.me && !state.me.isAdmin) {
          state.me = await api('/api/me');
          renderMe();
        }
        if (!$('modal-admin').classList.contains('hidden')) loadAdminUsers();
      } catch (e) { /* ignore */ }
    });

    socket.on('message', async (msg) => {
      const other = msg.from === state.me.id ? msg.to : msg.from;
      const known = state.contacts.some((c) => c.id === other);
      if (!known) await loadContacts();

      if (state.cache[other]) state.cache[other].push(msg);

      const c = state.contacts.find((x) => x.id === other);
      if (c) c.last = msg;

      if (state.current === other) {
        if (!state.cache[other]) await loadHistory(other);
        else appendMessage(msg);
        scrollBottom();
        markRead(other);
      } else if (msg.from !== state.me.id) {
        state.unread[other] = (state.unread[other] || 0) + 1;
      }
      renderContacts();
    });
  }

  /* ---------------- Contacts ---------------- */

  async function loadContacts() {
    state.contacts = await api('/api/contacts');
    state.contacts.forEach((c) => { if (c.online) state.online.add(c.id); });

    if (!state.unreadInit) {
      const map = readMap();
      state.contacts.forEach((c) => {
        const l = c.last;
        state.unread[c.id] = l && l.from === c.id && l.ts > (map[c.id] || 0) ? 1 : 0;
      });
      state.unreadInit = true;
    }
    renderContacts();
    renderChatHeader();
  }

  function renderContacts() {
    const box = $('contact-list');
    const q = $('search').value.trim().toLowerCase();
    box.innerHTML = '';

    const list = state.contacts
      .filter((c) => (c.name + ' ' + c.pseudo).toLowerCase().includes(q))
      .sort((a, b) => {
        const ta = a.last ? a.last.ts : 0;
        const tb = b.last ? b.last.ts : 0;
        if (ta !== tb) return tb - ta;
        if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty-list';
      e.textContent = state.me.isAdmin
        ? 'Aucun utilisateur pour le moment.'
        : 'Aucun contact. Clique sur « Ajouter » et entre le code de partage d\'un ami.';
      box.appendChild(e);
      return;
    }

    list.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'contact' + (state.current === c.id ? ' active' : '');
      item.appendChild(avatarWithDot(c));

      const meta = document.createElement('div');
      meta.className = 'meta';

      const name = document.createElement('div');
      name.className = 'name';
      const nm = document.createElement('span');
      nm.textContent = c.name + (c.isAdmin ? ' (admin)' : '');
      name.appendChild(nm);
      if (c.last) {
        const t = document.createElement('time');
        t.textContent = fmtTime(c.last.ts);
        name.appendChild(t);
      }

      const prev = document.createElement('div');
      prev.className = 'preview';
      prev.textContent = c.last
        ? (c.last.from === state.me.id ? 'Vous : ' : '') + previewText(c.last)
        : 'Aucun message';

      meta.appendChild(name);
      meta.appendChild(prev);
      item.appendChild(meta);

      if (state.unread[c.id] > 0) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = state.unread[c.id];
        item.appendChild(b);
      }

      item.addEventListener('click', () => openChat(c.id));
      box.appendChild(item);
    });
  }

  $('search').addEventListener('input', renderContacts);

  /* ---------------- Chat ---------------- */

  function renderChatHeader() {
    const c = state.contacts.find((x) => x.id === state.current);
    if (!c) return;
    const holder = $('chat-avatar');
    holder.innerHTML = '';
    holder.appendChild(avatarWithDot(c));
    $('chat-name').textContent = c.name;
    $('btn-call').classList.toggle('hidden', !!c.isAdmin);
    $('chat-status').textContent = c.isAdmin
      ? 'Compte administrateur'
      : state.online.has(c.id) ? 'En ligne' : 'Hors ligne';
  }

  async function openChat(id) {
    state.current = id;
    $('chat-empty').classList.add('hidden');
    $('chat-panel').classList.remove('hidden');
    $('app-screen').classList.add('chat-open');
    renderChatHeader();
    try {
      if (!state.cache[id]) await loadHistory(id);
      else renderMessages(state.cache[id]);
    } catch (err) {
      toast(err.message);
    }
    markRead(id);
    renderContacts();
    $('msg-input').focus();
  }

  async function loadHistory(id) {
    state.cache[id] = await api('/api/messages/' + id);
    if (state.current === id) renderMessages(state.cache[id]);
  }

  function renderMessages(list) {
    const box = $('messages');
    box.innerHTML = '';
    box.dataset.lastDay = '';
    list.forEach(appendMessage);
    scrollBottom();
  }

  function appendMessage(m) {
    const box = $('messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const day = fmtDate(m.ts);
    if (box.dataset.lastDay !== day) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = fmtDay(m.ts);
      box.appendChild(sep);
      box.dataset.lastDay = day;
    }
    const row = document.createElement('div');
    row.className = 'msg ' + (m.from === state.me.id ? 'mine' : 'theirs');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.image) {
      bubble.classList.add('has-img');
      const img = document.createElement('img');
      img.className = 'chat-img';
      img.alt = 'Photo';
      img.loading = 'lazy';
      img.src = m.image;
      img.addEventListener('load', () => { if (stick) scrollBottom(); });
      img.addEventListener('click', () => {
        $('photo-full').src = m.image;
        openModal('modal-photo');
      });
      bubble.appendChild(img);
    }
    if (m.text) {
      const txt = document.createElement('div');
      txt.textContent = m.text;
      bubble.appendChild(txt);
    }
    const t = document.createElement('time');
    t.textContent = fmtTime(m.ts);
    bubble.appendChild(t);
    row.appendChild(bubble);
    box.appendChild(row);
  }

  function scrollBottom() {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  $('btn-back').addEventListener('click', () => {
    $('app-screen').classList.remove('chat-open');
    state.current = null;
    $('chat-panel').classList.add('hidden');
    $('chat-empty').classList.remove('hidden');
    renderContacts();
  });

  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('msg-input').value.trim();
    if (!text || !state.current) return;
    state.socket.emit('message:send', { to: state.current, text }, (res) => {
      if (res && res.error) toast(res.error);
    });
    $('msg-input').value = '';
  });

  // Envoi de photos
  $('btn-photo').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !state.current) return;
    const to = state.current;
    try {
      toast('Envoi de la photo…');
      const img = await readImage(file);
      const data = renderToDataUrl(img, { max: 1280, quality: 0.82 });
      const { url } = await api('/api/upload', 'POST', { data });
      const text = $('msg-input').value.trim();
      $('msg-input').value = '';
      state.socket.emit('message:send', { to, text, image: url }, (res) => {
        if (res && res.error) toast(res.error);
      });
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------------- Modales ---------------- */

  const openModal = (id) => $(id).classList.remove('hidden');
  const closeModal = (id) => $(id).classList.add('hidden');

  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  });

  /* ---------------- Ajout de contact ---------------- */

  $('btn-add').addEventListener('click', () => {
    $('add-code').value = '';
    $('add-error').textContent = '';
    openModal('modal-add');
    $('add-code').focus();
  });

  $('add-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('add-error').textContent = '';
    try {
      const c = await api('/api/contacts', 'POST', { code: $('add-code').value });
      closeModal('modal-add');
      toast(c.pseudo + ' a été ajouté à tes contacts !');
      await loadContacts();
      openChat(c.id);
    } catch (err) {
      $('add-error').textContent = err.message;
    }
  });

  /* ---------------- Réglages (utilisateur ET administrateur) ---------------- */

  function renderSettingsPreview() {
    const holder = $('settings-preview');
    holder.innerHTML = '';
    const isAdmin = !!state.me.isAdmin;
    const av = makeAvatar(
      {
        pseudo: isAdmin ? 'Administrateur' : ($('settings-nickname').value || state.me.pseudo),
        avatar: state.avatarValue,
        isAdmin,
      },
      true
    );
    state.avatarBroken = false;
    const im = av.querySelector('img');
    if (im && /^https?:/i.test(state.avatarValue)) {
      im.addEventListener('error', () => {
        state.avatarBroken = true;
        $('settings-error').textContent = 'Cette adresse ne donne pas une image. Utilise plutôt « Importer une photo ».';
      });
      im.addEventListener('load', () => {
        state.avatarBroken = false;
        if ($('settings-error').textContent.startsWith('Cette adresse')) $('settings-error').textContent = '';
      });
    }
    holder.appendChild(av);
  }

  $('btn-settings').addEventListener('click', async () => {
    $('settings-error').textContent = '';
    try {
      state.me = await api('/api/me');
    } catch (err) {
      return toast(err.message);
    }
    const me = state.me;
    const isAdmin = !!me.isAdmin;

    $('field-pseudo').classList.toggle('hidden', isAdmin);
    $('field-nickname').classList.toggle('hidden', isAdmin);
    $('share-section').classList.toggle('hidden', isAdmin);

    const code = $('settings-code');
    code.type = 'password';
    if (isAdmin) {
      $('code-label').textContent = 'Nouveau code administrateur (laisser vide pour ne pas changer)';
      code.value = '';
      code.maxLength = 40;
      code.placeholder = 'Nouveau code (4 caractères minimum)';
      code.inputMode = 'text';
    } else {
      $('code-label').textContent = 'Code secret (PIN à 4 chiffres)';
      code.value = me.pin || '';
      code.maxLength = 4;
      code.placeholder = '••••';
      code.inputMode = 'numeric';
      $('settings-pseudo').value = me.pseudo;
      $('settings-nickname').value = me.nickname || '';
      $('settings-share').textContent = me.shareCode;
    }

    state.avatarValue = me.avatar || '';
    $('settings-avatar-url').value = /^https?:/i.test(state.avatarValue) ? state.avatarValue : '';
    $('settings-avatar-url').placeholder = state.avatarValue.startsWith('data:')
      ? '(photo importée)'
      : 'https://…';
    state.avatarBroken = false;
    renderSettingsPreview();
    markAppearanceButtons();
    openModal('modal-settings');
  });

  $('settings-nickname').addEventListener('input', renderSettingsPreview);

  $('settings-code').addEventListener('input', (e) => {
    if (!state.me.isAdmin) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  $('settings-code-toggle').addEventListener('click', () => {
    const i = $('settings-code');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  $('settings-avatar-url').addEventListener('input', (e) => {
    state.avatarValue = fixImageUrl(e.target.value);
    renderSettingsPreview();
  });

  $('settings-avatar-clear').addEventListener('click', () => {
    state.avatarValue = '';
    $('settings-avatar-url').value = '';
    $('settings-avatar-url').placeholder = 'https://…';
    renderSettingsPreview();
  });

  $('settings-avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await readImage(file);
      state.avatarValue = renderToDataUrl(img, { max: 160, square: true, quality: 0.85 });
      $('settings-avatar-url').value = '';
      $('settings-avatar-url').placeholder = '(photo importée)';
      renderSettingsPreview();
    } catch (err) {
      toast(err.message);
    }
  });

  $('settings-share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('settings-share').textContent);
      toast('Code de partage copié !');
    } catch (e) {
      toast('Copie impossible, note le code manuellement.');
    }
  });

  $('settings-share-reset').addEventListener('click', async () => {
    if (!confirm('Réinitialiser ton code de partage ? L\'ancien code ne fonctionnera plus.')) return;
    try {
      const r = await api('/api/me/reset-code', 'POST');
      state.me.shareCode = r.shareCode;
      $('settings-share').textContent = r.shareCode;
      toast('Nouveau code de partage : ' + r.shareCode);
    } catch (err) {
      $('settings-error').textContent = err.message;
    }
  });

  $('settings-save').addEventListener('click', async () => {
    $('settings-error').textContent = '';
    const isAdmin = !!state.me.isAdmin;
    const code = $('settings-code').value;
    const body = { avatar: state.avatarValue, appearance: state.appearance };

    if (state.avatarBroken && /^https?:/i.test(state.avatarValue)) {
      $('settings-error').textContent = 'La photo n\'est pas valide : importe-la depuis ton appareil ou retire-la.';
      return;
    }

    if (isAdmin) {
      if (code !== '') {
        if (code.length < 4) {
          $('settings-error').textContent = 'Le code administrateur doit faire au moins 4 caractères.';
          return;
        }
        body.pin = code;
      }
    } else {
      if (!/^\d{4}$/.test(code)) {
        $('settings-error').textContent = 'Le code PIN doit contenir exactement 4 chiffres.';
        return;
      }
      body.pin = code;
      body.nickname = $('settings-nickname').value;
    }

    const saveBtn = $('settings-save');
    saveBtn.disabled = true;
    try {
      state.me = await api('/api/me', 'PUT', body);
      renderMe();
      closeModal('modal-settings');
      toast(isAdmin && body.pin ? 'Réglages enregistrés. Nouveau code administrateur actif.' : 'Réglages enregistrés !');
    } catch (err) {
      $('settings-error').textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  /* ---------------- Administration ---------------- */

  $('btn-admin').addEventListener('click', () => { refreshReportsBadge(); openModal('modal-hub'); });
  $('admin-refresh').addEventListener('click', loadAdminUsers);

  async function loadAdminUsers() {
    let data;
    try {
      data = await api('/api/admin/users');
    } catch (err) {
      return toast(err.message);
    }
    const users = data.users;

    const info = $('admin-storage');
    info.textContent = data.storage.warning
      ? '⚠️ Stockage : ' + data.storage.label + ' — ton hébergeur semble effacer le disque ! Configure DATABASE_URL (PostgreSQL) ou DATA_DIR.'
      : '💾 Stockage : ' + data.storage.label;
    info.classList.toggle('warn', !!data.storage.warning);

    $('admin-count').textContent = users.length;
    const body = $('admin-table').querySelector('tbody');
    body.innerHTML = '';

    if (!users.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = 'Aucun compte pour le moment.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    users.forEach((u) => {
      const tr = document.createElement('tr');
      const cell = (child) => {
        const td = document.createElement('td');
        if (typeof child === 'string') td.textContent = child; else td.appendChild(child);
        tr.appendChild(td);
        return td;
      };

      const who = document.createElement('div');
      who.className = 'who';
      who.appendChild(makeAvatar(u));
      const nm = document.createElement('span');
      nm.textContent = u.nickname ? u.nickname + ' (' + u.pseudo + ')' : u.pseudo;
      who.appendChild(nm);
      cell(who);

      const pin = document.createElement('code');
      pin.textContent = u.pin;
      cell(pin);

      const share = document.createElement('code');
      share.textContent = u.shareCode;
      cell(share);

      cell(String(u.contacts));
      cell(String(u.reports || 0));
      cell(fmtDate(u.createdAt));

      const st = document.createElement('span');
      st.className = u.online ? 'status-on' : 'status-off';
      st.textContent = u.online ? '● En ligne' : '○ Hors ligne';
      if (u.bannedUntil) {
        st.className = 'status-off';
        st.style.color = 'var(--danger)';
        st.textContent = u.bannedUntil >= 32503680000000 ? '⛔ Banni définitivement' : '⛔ Banni jusqu\'au ' + fmtDate(u.bannedUntil) + ' ' + fmtTime(u.bannedUntil);
      }
      if (u.channelBan) st.textContent += ' · 🚫 chaînes';
      cell(st);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const chat = document.createElement('button');
      chat.className = 'btn small primary';
      chat.style.width = 'auto';
      chat.style.margin = '0';
      chat.textContent = 'Discuter';
      chat.addEventListener('click', () => {
        closeModal('modal-admin');
        openChat(u.id);
      });
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = 'Supprimer';
      del.addEventListener('click', async () => {
        if (!confirm('Supprimer définitivement le compte « ' + u.pseudo + ' » et ses messages ?')) return;
        try {
          await api('/api/admin/users/' + u.id, 'DELETE');
          if (state.current === u.id) $('btn-back').click();
          toast('Compte supprimé.');
        } catch (err) {
          toast(err.message);
        }
      });
      actions.appendChild(chat);
      const ban = document.createElement('button');
      ban.className = 'btn small' + (u.bannedUntil ? '' : ' danger');
      ban.textContent = u.bannedUntil ? 'Débannir' : 'Bannir';
      ban.addEventListener('click', async () => {
        if (!u.bannedUntil) return openBan(u.id, u.pseudo, loadAdminUsers);
        try { await api('/api/admin/users/' + u.id + '/unban', 'POST'); toast('Compte débanni.'); loadAdminUsers(); }
        catch (err) { toast(err.message); }
      });
      actions.appendChild(ban);
      if (u.channelBan) {
        const cb = document.createElement('button');
        cb.className = 'btn small';
        cb.textContent = 'Autoriser les chaînes';
        cb.addEventListener('click', async () => {
          try { await api('/api/admin/users/' + u.id + '/channel-ban', 'POST', { value: false }); toast('Chaînes autorisées.'); loadAdminUsers(); }
          catch (err) { toast(err.message); }
        });
        actions.appendChild(cb);
      }
      actions.appendChild(del);
      cell(actions);

      body.appendChild(tr);
    });
  }

  /* ---------------- Onglets : Discussions / Stories / Appels ---------------- */

  state.tab = 'chats';
  state.stories = [];
  state.viewer = null;
  state.storyImg = '';
  state.call = null;

  function showTab(tab) {
    state.tab = tab;
    ['chats', 'stories', 'channels', 'calls'].forEach((t) => {
      $('pane-' + t).classList.toggle('hidden', t !== tab);
      document.querySelector('[data-tab="' + t + '"]').classList.toggle('active', t === tab);
    });
    if (tab === 'stories') loadStories().catch((e) => toast(e.message));
    if (tab === 'channels') loadChannels().catch((e) => toast(e.message));
    if (tab === 'calls') loadCalls();
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function afterStart() {
    const admin = !!state.me.isAdmin;
    $('tabbar').classList.toggle('hidden', admin);
    showTab('chats');
    if (admin) refreshReportsBadge(); else loadStories().catch(() => {});
  }

  const emptyDiv = (text) => {
    const e = document.createElement('div');
    e.className = 'empty-list';
    e.textContent = text;
    return e;
  };

  function bindExtraSocket(socket) {
    socket.on('banned', ({ message }) => forceLogout(message));
    socket.on('channels:update', () => {
      if (!state.me || state.me.isAdmin) return;
      loadChannels().catch(() => {});
      if (!$('modal-channel').classList.contains('hidden') && state.chan) loadChanPosts(state.chan).catch(() => {});
    });
    socket.on('stories:update', () => {
      if (state.me && !state.me.isAdmin) loadStories().catch(() => {});
    });
    socket.on('calls:update', () => { if (state.tab === 'calls') loadCalls(); });
    socket.on('reports:update', () => {
      if (!state.me || !state.me.isAdmin) return;
      if (!$('modal-reports').classList.contains('hidden')) loadReports(); else refreshReportsBadge();
    });

    socket.on('call:incoming', ({ callId, from, name }) => {
      if (state.call) { socket.emit('call:end', { callId }); return; }
      const c = state.contacts.find((x) => x.id === from) || { id: from, pseudo: name, name };
      state.call = { id: callId, peerId: from, dir: 'in', stream: null, pc: null, pending: [] };
      showCall(c, 'Appel entrant…', true);
    });
    socket.on('call:accepted', async ({ callId }) => {
      const call = state.call;
      if (!call || call.id !== callId) return;
      try {
        setCallStatus('Connexion…');
        const pc = await makePc(call);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:signal', { callId, data: { sdp: pc.localDescription } });
      } catch (e) { toast('Appel impossible.'); hangup(); }
    });
    socket.on('call:signal', async ({ callId, data }) => {
      const call = state.call;
      if (!call || call.id !== callId || !data) return;
      const pc = call.pc;
      try {
        if (data.candidate) {
          if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
          else call.pending.push(data.candidate);
        } else if (data.sdp && pc) {
          await pc.setRemoteDescription(data.sdp);
          for (const cand of call.pending.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
          if (data.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('call:signal', { callId, data: { sdp: pc.localDescription } });
          }
        }
      } catch (e) { /* ignore */ }
    });
    socket.on('call:ended', ({ callId, reason }) => {
      const call = state.call;
      if (!call || call.id !== callId) return;
      const msgs = { declined: 'Appel refusé.', offline: 'Ton correspondant s\'est déconnecté.', missed: 'Appel manqué.', hangup: 'Appel terminé.' };
      cleanupCall();
      toast(msgs[reason] || 'Appel terminé.');
    });
  }

  /* ---------------- Profil du contact ---------------- */

  function openProfile() {
    const c = state.contacts.find((x) => x.id === state.current);
    if (!c) return;
    const av = $('profile-avatar');
    av.innerHTML = '';
    av.appendChild(makeAvatar(c, true));
    $('profile-name').textContent = c.name;
    $('profile-pseudo').textContent = c.pseudo;
    $('profile-nick').textContent = c.nickname || '—';
    $('profile-code').textContent = !c.isAdmin && c.shareCode ? c.shareCode : '—';
    $('profile-since').textContent = c.since ? fmtDate(c.since) : '—';
    $('profile-alias').value = c.alias || '';
    $('profile-actions').classList.toggle('hidden', !!c.isAdmin || !!state.me.isAdmin);
    openModal('modal-profile');
  }
  $('chat-id').addEventListener('click', openProfile);

  $('profile-alias-save').addEventListener('click', async () => {
    try {
      const r = await api('/api/contacts/' + state.current + '/alias', 'PUT', { alias: $('profile-alias').value });
      await loadContacts();
      openProfile();
      toast(r.alias ? 'Surnom enregistré.' : 'Surnom retiré.');
    } catch (err) { toast(err.message); }
  });

  $('profile-delete').addEventListener('click', async () => {
    const c = state.contacts.find((x) => x.id === state.current);
    if (!c || !confirm('Supprimer « ' + c.name + ' » de tes contacts ?')) return;
    try {
      await api('/api/contacts/' + c.id, 'DELETE');
      closeModal('modal-profile');
      $('btn-back').click();
      delete state.cache[c.id];
      await loadContacts();
      toast('Contact supprimé.');
    } catch (err) { toast(err.message); }
  });

  $('profile-report').addEventListener('click', () => {
    $('report-reason').value = '';
    $('report-error').textContent = '';
    closeModal('modal-profile');
    openModal('modal-report');
    $('report-reason').focus();
  });

  $('report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('report-error').textContent = '';
    try {
      await api('/api/contacts/' + state.current + '/report', 'POST', { reason: $('report-reason').value });
      closeModal('modal-report');
      toast('Signalement envoyé à l\'administrateur.');
    } catch (err) { $('report-error').textContent = err.message; }
  });

  /* ---------------- Stories ---------------- */

  async function loadStories() {
    state.stories = await api('/api/stories');
    renderStories();
    updateStoriesDot();
    refreshViewer();
  }

  function groupStories() {
    const g = {};
    state.stories.forEach((s) => { (g[s.userId] = g[s.userId] || []).push(s); });
    return g;
  }

  function updateStoriesDot() {
    $('stories-dot').classList.toggle('hidden', !state.stories.some((s) => !s.seen));
  }

  function storyUser(userId, fallbackName) {
    if (state.me && userId === state.me.id) return { pseudo: state.me.pseudo, name: state.me.name || state.me.pseudo, avatar: state.me.avatar };
    const c = state.contacts.find((x) => x.id === userId);
    return c || { pseudo: fallbackName, name: fallbackName, avatar: '' };
  }

  function storyRow(user, title, sub, seen, onClick, extra) {
    const item = document.createElement('div');
    item.className = 'contact';
    const ring = document.createElement('div');
    ring.className = 'ring' + (seen ? ' seen' : '');
    ring.appendChild(makeAvatar(user));
    item.appendChild(ring);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = title;
    const p = document.createElement('div');
    p.className = 'preview';
    p.textContent = sub;
    meta.appendChild(n);
    meta.appendChild(p);
    item.appendChild(meta);
    if (extra) item.appendChild(extra);
    item.addEventListener('click', onClick);
    return item;
  }

  function renderStories() {
    const box = $('stories-list');
    box.innerHTML = '';
    const g = groupStories();
    const mine = g[state.me.id] || [];

    const add = document.createElement('button');
    add.className = 'btn small primary';
    add.textContent = '＋ Ajouter';
    add.addEventListener('click', (e) => { e.stopPropagation(); openNewStory(); });
    box.appendChild(
      storyRow(
        storyUser(state.me.id), 'Ma story',
        mine.length ? mine.length + ' story' + (mine.length > 1 ? 's' : '') + ' · ' + fmtTime(mine[mine.length - 1].ts) : 'Partage une photo avec tes amis',
        true,
        () => (mine.length ? openViewer(state.me.id, 0) : openNewStory()),
        add
      )
    );

    const lab = document.createElement('div');
    lab.className = 'section-label';
    lab.textContent = 'Stories de tes amis';
    box.appendChild(lab);

    const others = Object.keys(g).filter((id) => id !== state.me.id).map((id) => g[id])
      .sort((a, b) => b[b.length - 1].ts - a[a.length - 1].ts);
    if (!others.length) box.appendChild(emptyDiv('Aucune story pour le moment.'));
    others.forEach((list) => {
      const first = list.findIndex((s) => !s.seen);
      const last = list[list.length - 1];
      const u = storyUser(last.userId, last.authorName);
      box.appendChild(
        storyRow(u, u.name, list.length + ' story' + (list.length > 1 ? 's' : '') + ' · ' + fmtTime(last.ts), first === -1,
          () => openViewer(last.userId, first === -1 ? 0 : first))
      );
    });
  }

  function openNewStory() {
    state.storyImg = '';
    $('story-preview').classList.add('hidden');
    $('story-text').value = '';
    $('story-error').textContent = '';
    openModal('modal-story-new');
  }

  async function pickStoryFile(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const img = await readImage(f);
      state.storyImg = renderToDataUrl(img, { max: 1280, quality: 0.82 });
      $('story-preview').src = state.storyImg;
      $('story-preview').classList.remove('hidden');
      $('story-error').textContent = '';
    } catch (err) { $('story-error').textContent = err.message; }
  }
  $('story-cam').addEventListener('change', pickStoryFile);
  $('story-file').addEventListener('change', pickStoryFile);

  $('story-publish').addEventListener('click', async () => {
    if (!state.storyImg) { $('story-error').textContent = 'Prends ou choisis d\'abord une photo.'; return; }
    const btn = $('story-publish');
    btn.disabled = true;
    try {
      const { url } = await api('/api/upload', 'POST', { data: state.storyImg });
      await api('/api/stories', 'POST', { image: url, text: $('story-text').value });
      closeModal('modal-story-new');
      toast('Story publiée !');
      await loadStories();
    } catch (err) { $('story-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  function curStory() {
    const v = state.viewer;
    if (!v) return null;
    return (groupStories()[v.userId] || [])[v.index] || null;
  }

  function openViewer(userId, index) {
    if (!(groupStories()[userId] || []).length) return;
    state.viewer = { userId, index, storyId: null };
    $('story-viewers').classList.add('hidden');
    showStory();
    openModal('modal-story');
  }

  function showStory() {
    const s = curStory();
    if (!s) return closeModal('modal-story');
    const list = groupStories()[s.userId];
    state.viewer.storyId = s.id;
    $('story-img').src = s.image;
    $('story-caption').textContent = s.text;
    $('story-caption').classList.toggle('hidden', !s.text);
    $('story-author').textContent = (s.mine ? 'Ma story' : storyUser(s.userId, s.authorName).name) + ' (' + (state.viewer.index + 1) + '/' + list.length + ')';
    $('story-time').textContent = fmtDay(s.ts) + ' ' + fmtTime(s.ts);
    $('story-delete').classList.toggle('hidden', !s.mine);
    $('story-viewers-btn').classList.toggle('hidden', !s.mine);
    $('story-views').textContent = s.viewsCount;
    $('story-like').textContent = (s.liked ? '❤️ ' : '🤍 ') + s.likes;
    $('story-like').disabled = !!s.mine;
    $('story-prev').disabled = state.viewer.index === 0;

    const vb = $('story-viewers');
    vb.innerHTML = '';
    if (s.mine) {
      if (!s.viewers.length) vb.textContent = 'Personne n\'a encore vu cette story.';
      s.viewers.forEach((v) => {
        const line = document.createElement('div');
        line.textContent = '👁 ' + v.name + ' · ' + fmtTime(v.ts) + (v.liked ? ' · ❤️' : '');
        vb.appendChild(line);
      });
    }
    if (!s.mine && !s.seen) {
      s.seen = true;
      api('/api/stories/' + s.id + '/view', 'POST').catch(() => {});
      updateStoriesDot();
      renderStories();
    }
  }

  function refreshViewer() {
    if ($('modal-story').classList.contains('hidden') || !state.viewer) return;
    const list = groupStories()[state.viewer.userId] || [];
    const i = list.findIndex((s) => s.id === state.viewer.storyId);
    if (i === -1) return closeModal('modal-story');
    state.viewer.index = i;
    showStory();
  }

  $('story-prev').addEventListener('click', () => { if (state.viewer.index > 0) { state.viewer.index--; showStory(); } });
  $('story-next').addEventListener('click', () => {
    const list = groupStories()[state.viewer.userId] || [];
    if (state.viewer.index < list.length - 1) { state.viewer.index++; showStory(); } else closeModal('modal-story');
  });
  $('story-viewers-btn').addEventListener('click', () => $('story-viewers').classList.toggle('hidden'));
  $('story-like').addEventListener('click', async () => {
    const s = curStory();
    if (!s || s.mine) return;
    try {
      const r = await api('/api/stories/' + s.id + '/like', 'POST');
      s.liked = r.liked;
      s.likes = r.likes;
      showStory();
    } catch (err) { toast(err.message); }
  });
  $('story-delete').addEventListener('click', async () => {
    const s = curStory();
    if (!s || !confirm('Supprimer cette story ?')) return;
    try {
      await api('/api/stories/' + s.id, 'DELETE');
      toast('Story supprimée.');
      await loadStories();
    } catch (err) { toast(err.message); }
  });

  /* ---------------- Appels vocaux ---------------- */

  const fmtDur = (s) => Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';

  async function loadCalls() {
    let list;
    try { list = await api('/api/calls'); } catch (e) { return; }
    const box = $('calls-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyDiv('Aucun appel pour le moment.')); return; }
    list.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'contact';
      item.appendChild(makeAvatar({ pseudo: r.name, name: r.name, avatar: r.avatar }));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = r.name;
      const bad = !r.outgoing && r.status !== 'ended';
      if (bad) n.style.color = 'var(--danger)';
      const p = document.createElement('div');
      p.className = 'preview';
      let label;
      if (r.outgoing) label = r.status === 'ended' ? '↗ Sortant' : r.status === 'declined' ? '↗ Refusé' : '↗ Sans réponse';
      else label = r.status === 'ended' ? '↙ Reçu' : r.status === 'declined' ? '↙ Refusé' : '↙ Manqué';
      p.textContent = label + ' · ' + fmtDay(r.ts) + ' ' + fmtTime(r.ts) + (r.duration ? ' · ' + fmtDur(r.duration) : '');
      meta.appendChild(n);
      meta.appendChild(p);
      item.appendChild(meta);
      if (r.callable) {
        const b = document.createElement('button');
        b.className = 'icon-btn';
        b.textContent = '📞';
        b.title = 'Rappeler';
        b.addEventListener('click', () => startCall(r.other));
        item.appendChild(b);
      }
      box.appendChild(item);
    });
  }

  function setCallStatus(t) { $('call-status').textContent = t; }

  function showCall(c, status, incoming) {
    const av = $('call-avatar');
    av.innerHTML = '';
    av.appendChild(makeAvatar(c, true));
    $('call-name').textContent = c.name || c.pseudo;
    setCallStatus(status);
    $('call-accept').classList.toggle('hidden', !incoming);
    $('call-overlay').classList.remove('hidden');
  }

  function cleanupCall() {
    const c = state.call;
    if (c) {
      clearInterval(c.timer);
      if (c.pc) { try { c.pc.close(); } catch (e) { /* ignore */ } }
      if (c.stream) c.stream.getTracks().forEach((t) => t.stop());
    }
    state.call = null;
    $('call-audio').srcObject = null;
    $('call-overlay').classList.add('hidden');
    if (state.tab === 'calls') loadCalls();
  }

  function hangup() {
    const c = state.call;
    if (!c) return;
    state.socket.emit('call:end', { callId: c.id });
    cleanupCall();
  }

  function callConnected() {
    const c = state.call;
    if (!c || c.startedAt) return;
    c.startedAt = Date.now();
    const tick = () => setCallStatus('En communication · ' + fmtDur(Math.round((Date.now() - c.startedAt) / 1000)));
    tick();
    c.timer = setInterval(tick, 1000);
  }

  async function makePc(call) {
    let servers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try { servers = await api('/api/ice'); } catch (e) { /* STUN par défaut */ }
    const pc = new RTCPeerConnection({ iceServers: servers });
    call.pc = pc;
    call.stream.getTracks().forEach((t) => pc.addTrack(t, call.stream));
    pc.onicecandidate = (e) => {
      if (e.candidate) state.socket.emit('call:signal', { callId: call.id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const a = $('call-audio');
      a.srcObject = e.streams[0];
      a.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') callConnected();
      if (pc.connectionState === 'failed') { toast('Connexion perdue.'); hangup(); }
    };
    return pc;
  }

  async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Micro indisponible (il faut une connexion HTTPS).');
      return null;
    }
    try { return await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('Autorise le micro pour pouvoir appeler.'); return null; }
  }

  async function startCall(id) {
    if (state.call) return toast('Un appel est déjà en cours.');
    const c = state.contacts.find((x) => x.id === id);
    if (!c || c.isAdmin) return;
    const stream = await getMic();
    if (!stream) return;
    state.socket.emit('call:invite', { to: id }, (res) => {
      if (!res || res.error) {
        stream.getTracks().forEach((t) => t.stop());
        return toast((res && res.error) || 'Appel impossible.');
      }
      state.call = { id: res.callId, peerId: id, dir: 'out', stream, pc: null, pending: [] };
      showCall(c, 'Appel en cours…', false);
    });
  }

  $('btn-call').addEventListener('click', () => startCall(state.current));
  $('call-hangup').addEventListener('click', hangup);
  $('call-accept').addEventListener('click', async () => {
    const call = state.call;
    if (!call) return;
    const stream = await getMic();
    if (!stream) return hangup();
    call.stream = stream;
    $('call-accept').classList.add('hidden');
    setCallStatus('Connexion…');
    try {
      await makePc(call);
      state.socket.emit('call:accept', { callId: call.id });
    } catch (e) { toast('Appel impossible.'); hangup(); }
  });

  /* ---------------- Signalements (administrateur) ---------------- */

  function setReportsBadge(n) {
    ['reports-badge', 'hub-reports-badge'].forEach((id) => {
      const b = $(id);
      b.textContent = n;
      b.classList.toggle('hidden', !n);
    });
  }

  async function refreshReportsBadge() {
    try {
      const d = await api('/api/admin/reports');
      setReportsBadge(d.open);
      return d;
    } catch (e) { return null; }
  }


  async function loadReports() {
    const d = await refreshReportsBadge();
    if (!d) return;
    const box = $('reports-list');
    box.innerHTML = '';
    const open = d.reports.filter((r) => r.status === 'open');
    const done = d.reports.filter((r) => r.status !== 'open');
    if (!open.length) box.appendChild(emptyDiv('Aucun signalement en attente.'));

    open.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'report-card';
      const h = document.createElement('strong');
      h.textContent = r.targetName + ' a été signalé(e) par ' + r.reporterName;
      const p = document.createElement('p');
      p.textContent = '« ' + r.reason + ' »';
      const m = document.createElement('small');
      m.textContent = fmtDay(r.ts) + ' ' + fmtTime(r.ts) + ' · ' + r.total + ' signalement(s) au total · ' + r.warnings + ' avertissement(s) déjà envoyé(s)';
      const row = document.createElement('div');
      row.className = 'row';

      const mk = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = 'btn small ' + cls;
        b.textContent = label;
        b.addEventListener('click', fn);
        row.appendChild(b);
        return b;
      };
      const act = async (fn, okMsg) => {
        try { await fn(); toast(okMsg); await loadReports(); } catch (err) { toast(err.message); }
      };

      const warn = mk('⚠️ Avertir', 'primary', () => {
        const def = 'Attention ' + r.targetPseudo + ', vous avez été jugé(e) par un signalement. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte.';
        const text = prompt('Avertissement envoyé à ' + r.targetPseudo + ' (tu peux le modifier) :', def);
        if (text === null) return;
        act(() => api('/api/admin/reports/' + r.id + '/warn', 'POST', { text }), 'Avertissement envoyé.');
      });
      mk('🙈 Ne rien faire', '', () => act(() => api('/api/admin/reports/' + r.id + '/dismiss', 'POST'), 'Signalement classé.'));
      const banB = mk('⛔ Bannir', 'danger', () => openBan(r.targetId, r.targetPseudo, () => loadReports(), r.id));
      const del = mk('🗑 Supprimer le compte', 'danger', () => {
        if (!confirm('Supprimer définitivement le compte « ' + r.targetPseudo + ' » et ses messages ?')) return;
        act(() => api('/api/admin/users/' + r.targetId, 'DELETE'), 'Compte supprimé.');
      });
      if (!r.targetExists) { warn.disabled = true; del.disabled = true; banB.disabled = true; }

      [h, p, m, row].forEach((x) => card.appendChild(x));
      box.appendChild(card);
    });

    if (done.length) {
      const lab = document.createElement('div');
      lab.className = 'section-label';
      lab.textContent = 'Déjà traités';
      box.appendChild(lab);
      done.slice(0, 30).forEach((r) => {
        const line = document.createElement('div');
        line.className = 'report-done';
        line.textContent = ({ warned: '⚠️ Avertissement envoyé', banned: '⛔ Ban appliqué' }[r.status] || '✔ Classé sans suite') + ' · ' + r.targetName + ' (par ' + r.reporterName + ') · ' + fmtDate(r.ts);
        box.appendChild(line);
      });
    }
  }

  /* ---------------- Chaînes ---------------- */

  state.channels = [];
  state.chan = null;
  state.chanEdit = null;
  state.chanAvatar = '';

  const chanUser = (c) => ({ pseudo: c.name, name: c.name, avatar: c.avatar });
  const subsText = (n) => n + ' abonné' + (n > 1 ? 's' : '');

  async function loadChannels() {
    state.channels = await api('/api/channels');
    renderChannels();
    if (!$('modal-chan-reco').classList.contains('hidden')) renderReco();
  }

  function chanRow(c, extra, rank) {
    const item = document.createElement('div');
    item.className = 'contact';
    if (rank) {
      const r = document.createElement('span');
      r.className = 'rank';
      r.textContent = rank;
      item.appendChild(r);
    }
    item.appendChild(makeAvatar(chanUser(c)));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = c.name + (c.mine ? ' (ma chaîne)' : '');
    const p = document.createElement('div');
    p.className = 'preview';
    p.textContent = subsText(c.subscribers) + (c.description ? ' · ' + c.description : '');
    meta.appendChild(n);
    meta.appendChild(p);
    item.appendChild(meta);
    if (extra) item.appendChild(extra);
    item.addEventListener('click', () => openChannel(c.id));
    return item;
  }

  function renderChannels() {
    const box = $('channels-list');
    box.innerHTML = '';
    const list = state.channels.filter((c) => c.subscribed || c.mine).sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length) {
      box.appendChild(emptyDiv('Tu ne suis aucune chaîne. Clique sur « Recommandations » pour en découvrir, ou crée la tienne.'));
      return;
    }
    list.forEach((c) => box.appendChild(chanRow(c)));
  }

  async function toggleFollow(id) {
    try {
      await api('/api/channels/' + id + '/follow', 'POST');
      await loadChannels();
      if (state.chan === id && !$('modal-channel').classList.contains('hidden')) loadChanPosts(id);
    } catch (err) { toast(err.message); }
  }

  function renderReco() {
    const box = $('reco-list');
    box.innerHTML = '';
    if (!state.channels.length) { box.appendChild(emptyDiv('Aucune chaîne pour le moment. Crée la première !')); return; }
    const top = document.createElement('div');
    top.className = 'section-label';
    top.textContent = '▲ Les plus suivies';
    box.appendChild(top);
    state.channels.forEach((c, i) => {
      let extra = null;
      if (!c.mine) {
        extra = document.createElement('button');
        extra.className = 'btn small' + (c.subscribed ? '' : ' primary');
        extra.style.width = 'auto';
        extra.style.margin = '0';
        extra.textContent = c.subscribed ? '✓ Suivie' : 'Suivre';
        extra.addEventListener('click', (e) => { e.stopPropagation(); toggleFollow(c.id); });
      }
      box.appendChild(chanRow(c, extra, i + 1));
    });
    const bottom = document.createElement('div');
    bottom.className = 'section-label';
    bottom.textContent = '▼ Les moins suivies';
    box.appendChild(bottom);
  }

  $('btn-chan-reco').addEventListener('click', async () => {
    try { await loadChannels(); } catch (e) { return toast(e.message); }
    renderReco();
    openModal('modal-chan-reco');
  });

  function renderPosts(box, posts, mine) {
    box.innerHTML = '';
    if (!posts.length) { box.appendChild(emptyDiv('Aucune publication pour le moment.')); return; }
    posts.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'chan-post';
      if (p.image) {
        const img = document.createElement('img');
        img.className = 'chat-img';
        img.alt = 'Photo';
        img.loading = 'lazy';
        img.src = p.image;
        img.addEventListener('click', () => { $('photo-full').src = p.image; openModal('modal-photo'); });
        card.appendChild(img);
      }
      if (p.video) {
        const v = document.createElement('video');
        v.className = 'chan-video';
        v.src = p.video;
        v.controls = true;
        v.preload = 'metadata';
        v.playsInline = true;
        card.appendChild(v);
      }
      if (p.text) {
        const t = document.createElement('p');
        t.textContent = p.text;
        card.appendChild(t);
      }
      const meta = document.createElement('small');
      const when = document.createElement('span');
      when.textContent = fmtDay(p.ts) + ' ' + fmtTime(p.ts);
      meta.appendChild(when);
      if (mine) {
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.textContent = '🗑';
        del.title = 'Supprimer cette publication';
        del.addEventListener('click', async () => {
          if (!confirm('Supprimer cette publication ?')) return;
          try { await api('/api/channels/' + state.chan + '/posts/' + p.id, 'DELETE'); } catch (err) { toast(err.message); }
        });
        meta.appendChild(del);
      }
      card.appendChild(meta);
      box.appendChild(card);
    });
  }

  async function openChannel(id) {
    state.chan = id;
    closeModal('modal-chan-reco');
    openModal('modal-channel');
    try { await loadChanPosts(id); } catch (err) { toast(err.message); closeModal('modal-channel'); }
  }

  async function loadChanPosts(id) {
    const d = await api('/api/channels/' + id + '/posts');
    if (state.chan !== id) return;
    const c = d.channel;
    state.chanData = c;
    const av = $('chan-avatar');
    av.innerHTML = '';
    av.appendChild(makeAvatar(chanUser(c), true));
    $('chan-name').textContent = c.name;
    $('chan-subs').textContent = subsText(c.subscribers);
    $('chan-desc').textContent = c.description;
    $('chan-desc').classList.toggle('hidden', !c.description);
    const f = $('chan-follow');
    f.classList.toggle('hidden', c.mine);
    f.textContent = c.subscribed ? '✓ Abonné(e)' : 'S\'abonner';
    $('chan-edit').classList.toggle('hidden', !c.mine);
    $('chan-delete').classList.toggle('hidden', !c.mine);
    $('chan-compose').classList.toggle('hidden', !c.mine);
    const box = $('chan-posts');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    renderPosts(box, d.posts, c.mine);
    if (stick) box.scrollTop = box.scrollHeight;
  }

  $('chan-follow').addEventListener('click', () => toggleFollow(state.chan));

  $('chan-delete').addEventListener('click', async () => {
    if (!confirm('Supprimer définitivement cette chaîne et toutes ses publications ?')) return;
    try {
      await api('/api/channels/' + state.chan, 'DELETE');
      closeModal('modal-channel');
      state.chan = null;
      toast('Chaîne supprimée.');
      loadChannels();
    } catch (err) { toast(err.message); }
  });

  async function postToChannel(body) {
    await api('/api/channels/' + state.chan + '/posts', 'POST', body);
    await loadChanPosts(state.chan);
    const box = $('chan-posts');
    box.scrollTop = box.scrollHeight;
  }

  $('chan-compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('chan-text').value.trim();
    if (!text) return;
    try { await postToChannel({ text }); $('chan-text').value = ''; } catch (err) { toast(err.message); }
  });

  $('chan-photo-btn').addEventListener('click', () => $('chan-photo').click());
  $('chan-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('Envoi de la photo…');
      const img = await readImage(file);
      const { url } = await api('/api/upload', 'POST', { data: renderToDataUrl(img, { max: 1280, quality: 0.82 }) });
      const text = $('chan-text').value.trim();
      await postToChannel({ text, image: url });
      $('chan-text').value = '';
    } catch (err) { toast(err.message); }
  });

  $('chan-video-btn').addEventListener('click', () => $('chan-video').click());
  $('chan-video').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) return toast('Vidéo trop lourde (30 Mo maximum).');
    try {
      toast('Envoi de la vidéo… (peut prendre un moment)');
      const res = await fetch('/api/upload-video', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'video/mp4', Authorization: 'Bearer ' + state.token },
        body: file,
      });
      let data = {};
      try { data = await res.json(); } catch (x) { /* pas de JSON */ }
      if (!res.ok) throw new Error(data.error || 'Envoi de la vidéo impossible.');
      const text = $('chan-text').value.trim();
      await postToChannel({ text, video: data.url });
      $('chan-text').value = '';
    } catch (err) { toast(err.message); }
  });

  function renderChanPreview() {
    const h = $('chan-edit-preview');
    h.innerHTML = '';
    const n = $('chan-edit-name').value || '?';
    h.appendChild(makeAvatar({ pseudo: n, name: n, avatar: state.chanAvatar }, true));
  }

  function openChanEdit(c) {
    state.chanEdit = c ? c.id : null;
    state.chanAvatar = c ? c.avatar : '';
    $('chan-edit-title').textContent = c ? 'Modifier la chaîne' : 'Créer une chaîne';
    $('chan-edit-name').value = c ? c.name : '';
    $('chan-edit-desc').value = c ? c.description : '';
    $('chan-edit-error').textContent = '';
    renderChanPreview();
    openModal('modal-chan-edit');
  }

  $('btn-chan-new').addEventListener('click', () => openChanEdit(null));
  $('chan-edit').addEventListener('click', () => openChanEdit(state.chanData));
  $('chan-edit-name').addEventListener('input', renderChanPreview);
  $('chan-edit-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await readImage(file);
      const { url } = await api('/api/upload', 'POST', { data: renderToDataUrl(img, { max: 256, square: true, quality: 0.85 }) });
      state.chanAvatar = url;
      renderChanPreview();
    } catch (err) { $('chan-edit-error').textContent = err.message; }
  });

  $('chan-edit-save').addEventListener('click', async () => {
    $('chan-edit-error').textContent = '';
    const body = { name: $('chan-edit-name').value, description: $('chan-edit-desc').value, avatar: state.chanAvatar };
    try {
      const c = state.chanEdit
        ? await api('/api/channels/' + state.chanEdit, 'PUT', body)
        : await api('/api/channels', 'POST', body);
      closeModal('modal-chan-edit');
      await loadChannels();
      if (state.chanEdit) loadChanPosts(c.id); else openChannel(c.id);
    } catch (err) { $('chan-edit-error').textContent = err.message; }
  });

  /* ---------------- Administration : hub, bans, sanctions ---------------- */

  document.querySelectorAll('[data-hub]').forEach((b) => {
    b.addEventListener('click', () => {
      closeModal('modal-hub');
      const k = b.dataset.hub;
      if (k === 'reports') { openModal('modal-reports'); loadReports(); }
      else if (k === 'users') { openModal('modal-admin'); loadAdminUsers(); }
      else if (k === 'stories') { openModal('modal-admin-stories'); loadAdminStories(); }
      else { openModal('modal-admin-channels'); loadAdminChannels(); }
    });
  });

  function markBanPreset() {
    document.querySelectorAll('.ban-presets .btn').forEach((b) => {
      const v = b.dataset.min === 'perm' ? 'perm' : Number(b.dataset.min);
      b.classList.toggle('active', state.ban && state.ban.sel === v);
    });
  }

  function openBan(userId, name, done, reportId) {
    state.ban = { userId, done, reportId, sel: 1440 };
    $('ban-target').textContent = name;
    $('ban-num').value = '';
    $('ban-error').textContent = '';
    markBanPreset();
    openModal('modal-ban');
  }

  document.querySelectorAll('.ban-presets .btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.ban.sel = b.dataset.min === 'perm' ? 'perm' : Number(b.dataset.min);
      $('ban-num').value = '';
      markBanPreset();
    });
  });
  $('ban-num').addEventListener('input', () => { state.ban.sel = null; markBanPreset(); });

  $('ban-confirm').addEventListener('click', async () => {
    const b = state.ban;
    const body = { reportId: b.reportId };
    if (b.sel === 'perm') body.permanent = true;
    else body.minutes = b.sel || Number($('ban-num').value) * Number($('ban-unit').value);
    if (!body.permanent && !(body.minutes >= 1)) { $('ban-error').textContent = 'Choisis une durée.'; return; }
    try {
      await api('/api/admin/users/' + b.userId + '/ban', 'POST', body);
      closeModal('modal-ban');
      toast('Compte banni.');
      if (b.done) b.done();
    } catch (err) { $('ban-error').textContent = err.message; }
  });

  function openSanction(o) {
    state.sanction = o;
    $('sanction-title').textContent = o.title;
    $('sanction-sub').textContent = o.sub;
    $('sanction-warn').checked = true;
    $('sanction-text').disabled = false;
    $('sanction-text').value = o.defaultText;
    $('sanction-block-row').classList.toggle('hidden', !o.block);
    $('sanction-block').checked = true;
    $('sanction-error').textContent = '';
    openModal('modal-sanction');
  }
  $('sanction-warn').addEventListener('change', (e) => { $('sanction-text').disabled = !e.target.checked; });
  $('sanction-confirm').addEventListener('click', async () => {
    const o = state.sanction;
    const warn = $('sanction-warn').checked ? $('sanction-text').value.trim() : '';
    try {
      await o.onConfirm({ warn, block: o.block && $('sanction-block').checked });
      closeModal('modal-sanction');
    } catch (err) { $('sanction-error').textContent = err.message; }
  });

  function adminCard(parts) {
    const card = document.createElement('div');
    card.className = 'report-card';
    parts.forEach((p) => card.appendChild(p));
    return card;
  }
  const el = (tag, text, cls) => {
    const x = document.createElement(tag);
    if (text !== undefined) x.textContent = text;
    if (cls) x.className = cls;
    return x;
  };
  const btnEl = (label, cls, fn) => {
    const b = el('button', label, 'btn small ' + cls);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  async function loadAdminStories() {
    let list;
    try { list = await api('/api/admin/stories'); } catch (e) { return toast(e.message); }
    const box = $('admin-stories-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyDiv('Aucune story en ce moment.')); return; }
    list.forEach((s) => {
      const img = el('img', undefined, 'admin-thumb');
      img.src = s.image;
      img.alt = 'Story';
      img.addEventListener('click', () => { $('photo-full').src = s.image; openModal('modal-photo'); });
      const row = el('div', undefined, 'row');
      row.appendChild(btnEl('🗑 Supprimer…', 'danger', () => openSanction({
        title: 'Supprimer la story',
        sub: 'Auteur : ' + s.authorName,
        block: false,
        defaultText: 'Attention ' + s.authorPseudo + ', une de vos stories a été supprimée car elle ne respectait pas les règles. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte.',
        onConfirm: async ({ warn }) => {
          await api('/api/admin/stories/' + s.id + '/delete', 'POST', { warn });
          toast('Story supprimée.');
          loadAdminStories();
        },
      })));
      const parts = [el('strong', s.authorName), img];
      if (s.text) parts.push(el('p', s.text));
      parts.push(el('small', fmtDay(s.ts) + ' ' + fmtTime(s.ts) + ' · ❤️ ' + s.likes + ' · 👁 ' + s.views), row);
      box.appendChild(adminCard(parts));
    });
  }

  async function loadAdminChannels() {
    let list;
    try { list = await api('/api/admin/channels'); } catch (e) { return toast(e.message); }
    const box = $('admin-channels-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyDiv('Aucune chaîne pour le moment.')); return; }
    list.forEach((c) => {
      const head = el('div', undefined, 'row');
      head.appendChild(makeAvatar(chanUser(c)));
      head.appendChild(el('strong', c.name));
      const postsBox = el('div', undefined, 'chan-posts hidden');
      const row = el('div', undefined, 'row');
      row.appendChild(btnEl('👁 Voir le contenu', '', async () => {
        if (!postsBox.childElementCount) {
          try { const d = await api('/api/channels/' + c.id + '/posts'); renderPosts(postsBox, d.posts, false); }
          catch (err) { return toast(err.message); }
        }
        postsBox.classList.toggle('hidden');
      }));
      row.appendChild(btnEl('🗑 Supprimer…', 'danger', () => openSanction({
        title: 'Supprimer la chaîne « ' + c.name + ' »',
        sub: 'Créée par ' + c.ownerName,
        block: c.ownerExists,
        defaultText: 'Attention ' + c.ownerPseudo + ', votre chaîne « ' + c.name + ' » a été supprimée car elle ne respectait pas les règles. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte.',
        onConfirm: async ({ warn, block }) => {
          await api('/api/admin/channels/' + c.id + '/delete', 'POST', { warn, block });
          toast('Chaîne supprimée.');
          loadAdminChannels();
        },
      })));
      const parts = [head];
      if (c.description) parts.push(el('p', c.description));
      parts.push(el('small', 'Créée par ' + c.ownerName + ' · ' + fmtDate(c.createdAt) + ' · ' + subsText(c.subscribers) + ' · ' + c.posts + ' publication(s)'), row, postsBox);
      box.appendChild(adminCard(parts));
    });
  }

  /* ---------------- Démarrage ---------------- */

  (async function init() {
    // Application installable (iPhone, Samsung, ordinateur)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const pending = sessionStorage.getItem('tc_msg');
    if (pending) {
      sessionStorage.removeItem('tc_msg');
      authError(pending);
    }
    if (!state.token) return;
    try {
      state.me = await api('/api/me');
      await startApp();
    } catch (e) {
      localStorage.removeItem('tc_token');
      state.token = null;
    }
  })();
})();
