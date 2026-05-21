/**
 * ══════════════════════════════════════════════════════════════
 * Valle del Río — Servidor Multijugador (CORREGIDO Y FLUIDO)
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  30000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

const MAP_SEED = 20250101;
const players = {};
const worldActions = [];
const MAX_WORLD_ACTIONS = 2000;

// Cambiamos a un mapa para optimizar la eliminación de duplicados en O(1)
const tileChanges = new Map();

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Jugador';
  return name.replace(/[<>&"']/g, '').trim().substring(0, 24) || 'Jugador';
}

function sanitizeMsg(msg) {
  if (typeof msg !== 'string') return '';
  return msg.replace(/[<>&"']/g, '').trim().substring(0, 120);
}

function isValidCoord(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v < 480 * 48;
}

app.get('/', (_req, res) => {
  res.json({
    game:    'Valle del Río',
    status:  'online',
    players: Object.keys(players).length,
    mapSeed: MAP_SEED
  });
});

app.get('/health', (_req, res) => res.sendStatus(200));

io.on('connection', (socket) => {
  console.log(`✅ Conectado: ${socket.id}`);

  socket.emit('init', { mapSeed: MAP_SEED });

  socket.on('join', (data) => {
    const x = isValidCoord(data.x) ? data.x : 400;
    const y = isValidCoord(data.y) ? data.y : 432;

    players[socket.id] = {
      id:     socket.id,
      x,
      y,
      facing: ['up','down','left','right'].includes(data.facing) ? data.facing : 'down',
      name:   sanitizeName(data.name),
      color:  /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : '#ff8080',
      action: null,
      tool: null,
      heldItem: null,
      heldLog: false,
      fishing: false
    };

    // Al unirse, le enviamos TODOS los jugadores actuales (para que no sean invisibles)
    socket.emit('currentPlayers', players);
    
    if (worldActions.length > 0) {
      socket.emit('worldHistory', worldActions);
    }

    // Avisamos a todos los demás que entró alguien nuevo
    socket.broadcast.emit('playerJoined', players[socket.id]);
    console.log(`👤 "${players[socket.id].name}" se unió. Total: ${Object.keys(players).length}`);
  });

  socket.on('move', (data) => {
    if (!players[socket.id]) return;

    // Procesamos la posición sin bloquear paquetes por milisegundos (evita congelamientos por lag)
    const x = isValidCoord(data.x) ? data.x : players[socket.id].x;
    const y = isValidCoord(data.y) ? data.y : players[socket.id].y;

    players[socket.id].x        = x;
    players[socket.id].y        = y;
    players[socket.id].facing   = ['up','down','left','right'].includes(data.facing) ? data.facing : players[socket.id].facing;
    players[socket.id].action   = data.action   || null;
    players[socket.id].tool     = data.tool     || null;
    players[socket.id].heldItem = data.heldItem || null;
    players[socket.id].heldLog  = !!data.heldLog;
    players[socket.id].fishing  = !!data.fishing;

    // Emitimos usando io.emit o broadcast según requiera tu cliente. 
    // Para asegurar fluidez absoluta en redes externas, retransmitimos los datos actualizados:
    socket.broadcast.emit('playerMoved', {
      id:       socket.id,
      x,
      y,
      facing:   players[socket.id].facing,
      action:   players[socket.id].action,
      tool:     players[socket.id].tool,
      heldItem: players[socket.id].heldItem,
      heldLog:  players[socket.id].heldLog,
      fishing:  players[socket.id].fishing
    });
  });

  socket.on('worldAction', (data) => {
    if (!players[socket.id]) return;
    if (typeof data.type !== 'string') return;

    if (data.type === 'tileChange') {
      if (typeof data.row !== 'number' || typeof data.col !== 'number') return;
      if (data.row < 0 || data.row >= 336 || data.col < 0 || data.col >= 480) return;

      const tileKey = `${data.row}_${data.col}`;
      
      // Optimización O(1) para reemplazar baldosas viejas
      if (tileChanges.has(tileKey)) {
        const oldAction = tileChanges.get(tileKey);
        const idx = worldActions.indexOf(oldAction);
        if (idx !== -1) worldActions.splice(idx, 1);
      }

      const action = { ...data, playerId: socket.id };
      tileChanges.set(tileKey, action);
      worldActions.push(action);
    } else {
      worldActions.push({ ...data, playerId: socket.id });
    }

    if (worldActions.length > MAX_WORLD_ACTIONS) {
      const removed = worldActions.shift();
      if (removed && removed.type === 'tileChange') {
        tileChanges.delete(`${removed.row}_${removed.col}`);
      }
    }

    io.emit('worldAction', { ...data, playerId: socket.id });
  });

  socket.on('chat', (data) => {
    if (!players[socket.id]) return;
    const msg = sanitizeMsg(data.msg);
    if (!msg) return;

    io.emit('chat', {
      name:  players[socket.id].name,
      color: players[socket.id].color,
      msg
    });
  });

  socket.on('disconnect', (reason) => {
    const name = players[socket.id]?.name ?? socket.id;
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    console.log(`❌ "${name}" se desconectó. Total: ${Object.keys(players).length}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Valle del Río · Servidor Fluido en puerto ${PORT}`);
});
