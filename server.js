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
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  30000,
  pingInterval: 10000,
  // Mejora latencia en tiempo real
  transports: ['websocket', 'polling']
});

// ─── Archivos estáticos (MP3, etc.) ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Semilla del mapa ────────────────────────────────────────────────────────
const MAP_SEED = 20250101;

// ─── Estado global del mundo ─────────────────────────────────────────────────
const players = {};
const worldActions = [];
const MAX_WORLD_ACTIONS = 2000;

// ─── Rate-limit para 'move' ───────────────────────────────────────────────────
// FIX: Bajado de 40ms a 16ms para permitir ~60 updates/seg en tiempo real
const MOVE_INTERVAL_MS = 16;
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
  // FIX: límite ampliado y logging para detectar coordenadas rechazadas
  return typeof v === 'number' && isFinite(v) && v >= 0 && v < 480 * 48;
}

function isValidFacing(f) {
  return ['up', 'down', 'left', 'right'].includes(f);
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

app.get('/health', (_req, res) => res.sendStatus(200));

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✅ Conectado: ${socket.id}`);

  socket.emit('init', { mapSeed: MAP_SEED });

  socket.on('join', (data) => {
    // FIX: guard contra doble join — limpiar estado anterior si existe
    if (players[socket.id]) {
      console.log(`⚠️  "${socket.id}" hizo join duplicado, limpiando estado anterior.`);
      delete players[socket.id];
      delete lastMoveTime[socket.id];
    }

    const x = isValidCoord(data.x) ? data.x : 400;
    const y = isValidCoord(data.y) ? data.y : 432;

    if (!isValidCoord(data.x) || !isValidCoord(data.y)) {
      console.log(`⚠️  Coordenadas inválidas en join (x:${data.x}, y:${data.y}) → usando default`);
    }

    // FIX: registrar al jugador ANTES de emitir currentPlayers
    // para que aparezca incluido en su propio snapshot inicial
    players[socket.id] = {
      id:     socket.id,
      x,
      y,
      facing: isValidFacing(data.facing) ? data.facing : 'down',
      name:   sanitizeName(data.name),
      color:  /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : '#ff8080',
      action: null
    };

    // Enviar estado completo al jugador que se une (incluye a sí mismo)
    socket.emit('currentPlayers', players);

    // Enviar historial del mundo si existe
    if (worldActions.length > 0) {
      socket.emit('worldHistory', worldActions);
    }

    // FIX: usar io.emit en vez de socket.broadcast.emit para que
    // el propio cliente también reciba el evento y pueda verse a sí mismo
    // si el cliente lo necesita para inicializar su sprite local.
    // Nota: si el cliente ya se inicializa con currentPlayers, podés
    // dejarlo en broadcast. Ambas opciones están abajo — elegí una:

    // OPCIÓN A (recomendada): solo avisarle a los OTROS jugadores
    socket.broadcast.emit('playerJoined', players[socket.id]);

    // OPCIÓN B: avisarle a todos incluyendo al propio jugador (descomentá si el
    // cliente necesita recibir su propio playerJoined para inicializarse)
    // io.emit('playerJoined', players[socket.id]);

    console.log(`👤 "${players[socket.id].name}" se unió en (${x},${y}). Jugadores: ${Object.keys(players).length}`);
  });

  socket.on('move', (data) => {
    if (!players[socket.id]) return;

    const now = Date.now();
    if (now - (lastMoveTime[socket.id] || 0) < MOVE_INTERVAL_MS) return;
    lastMoveTime[socket.id] = now;

    const x = isValidCoord(data.x) ? data.x : players[socket.id].x;
    const y = isValidCoord(data.y) ? data.y : players[socket.id].y;

    if (!isValidCoord(data.x) || !isValidCoord(data.y)) {
      console.log(`⚠️  Coordenadas inválidas en move (${data.x},${data.y}) para ${players[socket.id].name}`);
    }

    players[socket.id].x        = x;
    players[socket.id].y        = y;
    players[socket.id].facing   = isValidFacing(data.facing) ? data.facing : players[socket.id].facing;
    players[socket.id].action   = data.action   || null;
    players[socket.id].tool     = data.tool     || null;
    players[socket.id].heldItem = data.heldItem || null;
    players[socket.id].heldLog  = data.heldLog  || false;
    players[socket.id].fishing  = data.fishing  || false;

    // Broadcast a todos los demás en tiempo real
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

    io.emit('worldAction', action);
    console.log(`🌍 ${players[socket.id]?.name}: ${data.type} (${data.col ?? '-'},${data.row ?? '-'})`);
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
