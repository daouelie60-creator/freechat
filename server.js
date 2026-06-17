const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB for socket messages
});

// ── File Upload Setup ──
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(jpeg|png|gif|webp)|audio\/(webm|ogg|mpeg|wav|mp4)/;
    cb(null, allowed.test(file.mimetype));
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or unsupported type' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    type: req.file.mimetype.startsWith('image/') ? 'image' : 'voice',
    size: req.file.size,
    name: req.file.originalname
  });
});

// ── In-memory Store ──
const rooms = {};
const users = {}; // socketId -> { username, room, avatar }
const statuses = {}; // room -> [ { id, username, avatar, kind, text, bgColor, url, time, createdAt, viewers:Set } ]

const STATUS_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Remove expired statuses every minute
setInterval(() => {
  const cutoff = Date.now() - STATUS_TTL;
  Object.keys(statuses).forEach(room => {
    const before = statuses[room].length;
    statuses[room] = statuses[room].filter(s => s.createdAt > cutoff);
    if (statuses[room].length !== before) {
      io.to(room).emit('statuses', serializeStatuses(room));
    }
  });
}, 60 * 1000);

function serializeStatuses(room) {
  const cutoff = Date.now() - STATUS_TTL;
  return (statuses[room] || [])
    .filter(s => s.createdAt > cutoff)
    .map(s => ({
      id: s.id, username: s.username, avatar: s.avatar,
      kind: s.kind, text: s.text, bgColor: s.bgColor, url: s.url,
      time: s.time, createdAt: s.createdAt, viewCount: s.viewers.size
    }));
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ username, room }) => {
    socket.join(room);
    users[socket.id] = { username, room, avatar: getAvatar(username) };

    if (!rooms[room]) rooms[room] = { messages: [], members: new Set() };
    rooms[room].members.add(socket.id);

    socket.emit('history', rooms[room].messages.slice(-50));
    socket.emit('statuses', serializeStatuses(room));
    socket.to(room).emit('system', { text: `${username} joined the room`, time: now() });
    broadcastMembers(room);
  });

  // Text message
  socket.on('message', (text) => {
    const user = users[socket.id];
    if (!user) return;
    const msg = {
      id: Date.now(), username: user.username, avatar: user.avatar,
      text, time: now(), room: user.room, type: 'text'
    };
    rooms[user.room].messages.push(msg);
    if (rooms[user.room].messages.length > 200) rooms[user.room].messages.shift();
    io.to(user.room).emit('message', msg);
  });

  // Media message (image or voice) — sent after upload
  socket.on('media', ({ url, mediaType, duration }) => {
    const user = users[socket.id];
    if (!user) return;
    const msg = {
      id: Date.now(), username: user.username, avatar: user.avatar,
      text: null, url, mediaType, duration,
      time: now(), room: user.room, type: 'media'
    };
    rooms[user.room].messages.push(msg);
    if (rooms[user.room].messages.length > 200) rooms[user.room].messages.shift();
    io.to(user.room).emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(user.room).emit('typing', { username: user.username, isTyping });
  });

  // ── STATUS ──
  // Post a new status (text or image). For image, url comes from /upload first.
  socket.on('post-status', ({ kind, text, bgColor, url }) => {
    const user = users[socket.id];
    if (!user) return;
    if (!statuses[user.room]) statuses[user.room] = [];

    const status = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      username: user.username,
      avatar: user.avatar,
      kind: kind === 'image' ? 'image' : 'text',
      text: text ? String(text).slice(0, 280) : '',
      bgColor: bgColor || '#005c4b',
      url: url || null,
      time: now(),
      createdAt: Date.now(),
      viewers: new Set()
    };

    statuses[user.room].push(status);
    io.to(user.room).emit('statuses', serializeStatuses(user.room));
  });

  // Mark a status as viewed
  socket.on('view-status', (statusId) => {
    const user = users[socket.id];
    if (!user || !statuses[user.room]) return;
    const s = statuses[user.room].find(x => x.id === statusId);
    if (s) {
      s.viewers.add(user.username);
      io.to(user.room).emit('statuses', serializeStatuses(user.room));
    }
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      rooms[user.room]?.members.delete(socket.id);
      socket.to(user.room).emit('system', { text: `${user.username} left the room`, time: now() });
      broadcastMembers(user.room);
      delete users[socket.id];
    }
  });

  function broadcastMembers(room) {
    const members = Object.values(users)
      .filter(u => u.room === room)
      .map(u => ({ username: u.username, avatar: u.avatar }));
    io.to(room).emit('members', members);
  }
});

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getAvatar(username) {
  const colors = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#10b981','#06b6d4','#3b82f6'];
  let hash = 0;
  for (let c of username) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return { color: colors[Math.abs(hash) % colors.length], initials: username.slice(0, 2).toUpperCase() };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Chat server running on port ${PORT}`));
