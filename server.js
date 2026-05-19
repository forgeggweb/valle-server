/**
 * ══════════════════════════════════════════════════════════════
 *  Valle del Río — Servidor Multijugador
 *  Node.js 18+ · Socket.io 4.x · Express
 *
 *  Instalar:  npm install express socket.io
 *  Correr:    node server.js
 *  Railway:   el PORT lo inyecta automáticamente
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  30000,
  pingInterval: 10000
});

// ─── Semilla del mapa ────────────────────────────────────────────────────────
// Fija para que todos los clientes generen el mismo mundo.
// Cambiá el número si querés un mapa nuevo (y reiniciá el servidor).
const MAP_SEED = 20250101;

// ─── Estado global del mundo ─────────────────────────────────────────────────
const players = {};

// Historial de acciones del mundo (tala, cultivo, construcción…).
// Se envía al jugador nuevo para que vea los cambios hechos antes de unirse.
const worldActions = [];
const MAX_WORLD_ACTIONS = 2000;

// ─── Rate-limit simple para 'move' ───────────────────────────────────────────
const MOVE_INTERVAL_MS = 40; // mínimo 40 ms entre moves (~25 pps máx)
const lastMoveTime = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

// ─── HTTP ─────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    game:    'Valle del Río',
    status:  'online',
    players: Object.keys(players).length,
    mapSeed: MAP_SEED
  });
});

// Health-check para Railway / UptimeRobot
app.get('/health', (_req, res) => res.sendStatus(200));

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✅ Conectado: ${socket.id}`);

  // 1. Mandar semilla del mapa inmediatamente — antes del 'join'
  //    El cliente regenera el mapa si la semilla difiere de la suya.
  socket.emit('init', { mapSeed: MAP_SEED });

  // ── join ──────────────────────────────────────────────────────────────────
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
      action: null
    };

    // Al recién llegado: jugadores actuales + historial de cambios al mundo
    socket.emit('currentPlayers', players);
    if (worldActions.length > 0) {
      socket.emit('worldHistory', worldActions);
    }

    // A todos los demás: nuevo jugador
    socket.broadcast.emit('playerJoined', players[socket.id]);

    console.log(`👤 "${players[socket.id].name}" se unió. Jugadores: ${Object.keys(players).length}`);
  });

  // ── move ──────────────────────────────────────────────────────────────────
  socket.on('move', (data) => {
    if (!players[socket.id]) return;

    // Rate-limit
    const now = Date.now();
    if (now - (lastMoveTime[socket.id] || 0) < MOVE_INTERVAL_MS) return;
    lastMoveTime[socket.id] = now;

    const x = isValidCoord(data.x) ? data.x : players[socket.id].x;
    const y = isValidCoord(data.y) ? data.y : players[socket.id].y;

    players[socket.id].x      = x;
    players[socket.id].y      = y;
    players[socket.id].facing = ['up','down','left','right'].includes(data.facing)
                                  ? data.facing : players[socket.id].facing;
    players[socket.id].action = data.action || null;

    socket.broadcast.emit('playerMoved', {
      id:     socket.id,
      x,
      y,
      facing: players[socket.id].facing,
      action: players[socket.id].action
    });
  });

  // ── worldAction ───────────────────────────────────────────────────────────
  socket.on('worldAction', (data) => {
    if (!players[socket.id]) return;
    if (typeof data.type !== 'string') return;

    if (data.type === 'tileChange') {
      if (typeof data.row !== 'number' || typeof data.col !== 'number') return;
      if (data.row < 0 || data.row >= 336 || data.col < 0 || data.col >= 480) return;

      // Si ya hay una acción en ese tile, reemplazarla para ahorrar memoria
      const idx = worldActions.findIndex(
        a => a.type === 'tileChange' && a.row === data.row && a.col === data.col
      );
      if (idx !== -1) worldActions.splice(idx, 1);
    }

    const action = { ...data, playerId: socket.id };
    worldActions.push(action);
    if (worldActions.length > MAX_WORLD_ACTIONS) {
      worldActions.splice(0, worldActions.length - MAX_WORLD_ACTIONS);
    }

    // Reenviar a todos (el cliente filtra las propias por playerId)
    io.emit('worldAction', action);

    console.log(`🌍 ${players[socket.id]?.name}: ${data.type} (${data.col ?? '-'},${data.row ?? '-'})`);
  });

  // ── chat ──────────────────────────────────────────────────────────────────
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

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const name = players[socket.id]?.name ?? socket.id;
    console.log(`❌ "${name}" se desconectó (${reason}). Jugadores: ${Object.keys(players).length - 1}`);
    delete players[socket.id];
    delete lastMoveTime[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// ─── Arrancar ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Valle del Río · servidor en puerto ${PORT}`);
  console.log(`🗺️  MAP_SEED: ${MAP_SEED}`);
});
