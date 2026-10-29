const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.basePath = __dirname;
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// In-memory storage for Shorts (can be replaced with PostgreSQL/Supabase as used in Tonin Connect)
let shorts = [
  {
    id: '1',
    videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    title: 'Premier Short Tonin Connect 💎',
    description: 'Bienvenue sur le flux vidéo vertical !',
    author: 'Antonin',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Antonin',
    likes: 12,
    likedBy: [],
    comments: [
      { id: 'c1', author: 'Ilhan', text: 'Incroyable cette fonctionnalité !', date: new Date().toISOString() }
    ],
    createdAt: new Date().toISOString()
  }
];

// API Routes for Shorts
app.get('/api/shorts', (req, res) => {
  res.json(shorts);
});

app.post('/api/shorts', (req, res) => {
  const { videoUrl, title, description, author, avatar } = req.body;
  if (!videoUrl) {
    return res.status(400).json({ error: 'L\'URL de la vidéo est requise.' });
  }

  const newShort = {
    id: Date.now().toString(),
    videoUrl: videoUrl.trim(),
    title: title ? title.trim() : '',
    description: description ? description.trim() : '',
    author: author ? author.trim() : 'Anonyme',
    avatar: avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=default',
    likes: 0,
    likedBy: [],
    comments: [],
    createdAt: new Date().toISOString()
  };

  shorts.unshift(newShort);
  io.emit('new-short', newShort);
  res.status(201).json(newShort);
});

app.delete('/api/shorts/:id', (req, res) => {
  const { id } = req.params;
  const index = shorts.findIndex(s => s.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Vidéo introuvable.' });
  }
  shorts.splice(index, 1);
  io.emit('delete-short', id);
  res.json({ success: true });
});

app.post('/api/shorts/:id/like', (req, res) => {
  const { id } = req.params;
  const { username } = req.body;
  const short = shorts.find(s => s.id === id);
  if (!short) return res.status(404).json({ error: 'Vidéo introuvable.' });

  const userKey = username || 'Anonyme';
  const likedIndex = short.likedBy.indexOf(userKey);

  if (likedIndex > -1) {
    short.likedBy.splice(likedIndex, 1);
    short.likes = Math.max(0, short.likes - 1);
  } else {
    short.likedBy.push(userKey);
    short.likes += 1;
  }

  io.emit('update-short', short);
  res.json(short);
});

app.post('/api/shorts/:id/comment', (req, res) => {
  const { id } = req.params;
  const { text, author } = req.body;
  const short = shorts.find(s => s.id === id);
  if (!short) return res.status(404).json({ error: 'Vidéo introuvable.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Commentaire vide.' });

  const comment = {
    id: Date.now().toString(),
    author: author || 'Anonyme',
    text: text.trim(),
    date: new Date().toISOString()
  };

  short.comments.push(comment);
  io.emit('update-short', short);
  res.json(short);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur Tonin Connect démarré sur le port ${PORT}`);
});