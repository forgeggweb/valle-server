/**
 * ══════════════════════════════════════════════════════════════
 *  Valle del Río — Servidor Multijugador (VERSIÓN OPTIMIZADA)
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
  cors: { 
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout:  30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling'], // WebSocket primero para menor latencia
  allowEIO3: true // Compatibilidad con clientes viejos
});

// ─── Archivos estáticos ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Semilla del mapa ────────────────────────────────────────────
const MAP_SEED = 20250101;

// ─── Estado global del mundo ─────────────────────────────────────
const players = {};
const worldActions = [];
const MAX_WORLD_ACTIONS = 2000;

// ─── Rate-limit para 'move' (60 FPS = ~16.6ms) ───────────────────
const MOVE_INTERVAL_MS = 16;
const lastMoveTime = {};

// ─── Helpers ─────────────────────────────────────────────────────
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

function isValidFacing(f) {
  return ['up', 'down', 'left', 'right'].includes(f);
}

// ─── HTTP Endpoints ──────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    game:    'Valle del Río',
    status:  'online',
    players: Object.keys(players).length,
    mapSeed: MAP_SEED,
    timestamp: Date.now()
  });
});

app.get('/health', (_req, res) => res.sendStatus(200));

// ─── SOCKET.IO ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✅ Nuevo jugador conectado: ${socket.id}`);

  // 1. Enviar configuración inicial del mundo
  socket.emit('init', { 
    mapSeed: MAP_SEED,
    serverTime: Date.now()
  });

  // 2. Unirse al juego
  socket.on('join', (data) => {
    // Limpiar estado anterior si existe (por si acaso)
    if (players[socket.id]) {
      console.log(`⚠️  ${socket.id} hizo join duplicado, reciclando...`);
      delete players[socket.id];
      delete lastMoveTime[socket.id];
    }

    // Validar o asignar coordenadas iniciales
    let x = isValidCoord(data.x) ? data.x : 400;
    let y = isValidCoord(data.y) ? data.y : 432;

    if (!isValidCoord(data.x) || !isValidCoord(data.y)) {
      console.log(`⚠️  Coordenadas inválidas (${data.x},${data.y}) → usando spawn por defecto`);
    }

    // Crear jugador
    players[socket.id] = {
      id:     socket.id,
      x,
      y,
      facing: isValidFacing(data.facing) ? data.facing : 'down',
      name:   sanitizeName(data.name),
      color:  /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : '#ff8080',
      action: null,
      tool: null,
      heldItem: null,
      heldLog: false,
      fishing: false,
      joinTime: Date.now()
    };

    // Enviar lista completa de jugadores al recién llegado
    socket.emit('currentPlayers', players);
    console.log(`📤 Enviados ${Object.keys(players).length} jugadores a ${players[socket.id].name}`);

    // Enviar historial de acciones del mundo
    if (worldActions.length > 0) {
      socket.emit('worldHistory', worldActions);
      console.log(`📜 Historial enviado: ${worldActions.length} acciones`);
    }

    // Notificar a TODOS los jugadores (incluido el nuevo) que alguien se unió
    // Esto asegura que todos tengan la lista actualizada
    io.emit('playerJoined', players[socket.id]);

    console.log(`👤 "${players[socket.id].name}" se unió en (${x},${y}). Total: ${Object.keys(players).length}`);
  });

  // 3. Movimiento en tiempo real
  socket.on('move', (data) => {
    if (!players[socket.id]) return;

    // Rate limiting para evitar spam
    const now = Date.now();
    const lastMove = lastMoveTime[socket.id] || 0;
    if (now - lastMove < MOVE_INTERVAL_MS) return;
    lastMoveTime[socket.id] = now;

    const player = players[socket.id];
    
    // Validar coordenadas
    const x = isValidCoord(data.x) ? data.x : player.x;
    const y = isValidCoord(data.y) ? data.y : player.y;

    if (!isValidCoord(data.x) || !isValidCoord(data.y)) {
      console.log(`⚠️  Movimiento inválido de ${player.name}: (${data.x},${data.y})`);
    }

    // Actualizar estado del jugador
    player.x = x;
    player.y = y;
    player.facing = isValidFacing(data.facing) ? data.facing : player.facing;
    player.action = data.action || null;
    player.tool = data.tool || null;
    player.heldItem = data.heldItem || null;
    player.heldLog = data.heldLog || false;
    player.fishing = data.fishing || false;

    // Broadcast a TODOS los demás jugadores (excluyendo al emisor)
    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      x, y,
      facing: player.facing,
      action: player.action,
      tool: player.tool,
      heldItem: player.heldItem,
      heldLog: player.heldLog,
      fishing: player.fishing,
      timestamp: now
    });
  });

  // 4. Acciones del mundo (talar, minar, pescar, etc.)
  socket.on('worldAction', (data) => {
    if (!players[socket.id]) return;
    if (typeof data.type !== 'string') return;

    // Validar cambio de tile
    if (data.type === 'tileChange') {
      if (typeof data.row !== 'number' || typeof data.col !== 'number') return;
      if (data.row < 0 || data.row >= 336 || data.col < 0 || data.col >= 480) return;

      // Evitar duplicados: eliminar acción anterior del mismo tile
      const existingIdx = worldActions.findIndex(
        a => a.type === 'tileChange' && a.row === data.row && a.col === data.col
      );
      if (existingIdx !== -1) worldActions.splice(existingIdx, 1);
    }

    // Agregar nueva acción
    const action = { 
      ...data, 
      playerId: socket.id,
      playerName: players[socket.id].name,
      timestamp: Date.now()
    };
    worldActions.push(action);
    
    // Limitar historial
    while (worldActions.length > MAX_WORLD_ACTIONS) {
      worldActions.shift();
    }

    // Transmitir a TODOS los jugadores (incluido el que ejecutó la acción)
    io.emit('worldAction', action);
    console.log(`🌍 ${players[socket.id].name}: ${data.type} (${data.col ?? '-'},${data.row ?? '-'})`);
  });

  // 5. Chat en tiempo real
  socket.on('chat', (data) => {
    if (!players[socket.id]) return;
    const msg = sanitizeMsg(data.msg);
    if (!msg) return;

    io.emit('chat', {
      name: players[socket.id].name,
      color: players[socket.id].color,
      msg: msg,
      timestamp: Date.now()
    });
    console.log(`💬 ${players[socket.id].name}: ${msg}`);
  });

  // 6. Desconexión
  socket.on('disconnect', (reason) => {
    const player = players[socket.id];
    const name = player?.name ?? socket.id;
    console.log(`❌ "${name}" se desconectó. Razón: ${reason}`);
    
    delete players[socket.id];
    delete lastMoveTime[socket.id];
    
    // Notificar a todos que este jugador se fue
    io.emit('playerLeft', socket.id);
    console.log(`📊 Jugadores restantes: ${Object.keys(players).length}`);
  });
});

// ─── Sincronización periódica del estado (opcional, para mayor robustez) ─────
setInterval(() => {
  // Enviar estado completo a todos cada 5 segundos para corrección de desync
  io.emit('syncPlayers', players);
}, 5000);

// ─── Arrancar servidor ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ======================================`);
  console.log(`   Valle del Río · Servidor Multijugador`);
  console.log(`   Puerto: ${PORT}`);
  console.log(`   Map Seed: ${MAP_SEED}`);
  console.log(`   WebSocket ready para tiempo real`);
  console.log(`======================================\n`);
});
