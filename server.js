const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Estado de jugadores: { socketId: { id, x, y, facing, name, color, action } }
const players = {};

io.on('connection', (socket) => {
  console.log(`✅ Jugador conectado: ${socket.id}`);

  // Nuevo jugador se une
  socket.on('join', (data) => {
    players[socket.id] = {
      id: socket.id,
      x: data.x || 400,
      y: data.y || 400,
      facing: data.facing || 'down',
      name: data.name || 'Jugador',
      color: data.color || '#ff8080',
      action: null
    };

    // Mandarle al nuevo jugador todos los jugadores existentes
    socket.emit('currentPlayers', players);

    // Avisar a todos los demás que llegó alguien nuevo
    socket.broadcast.emit('playerJoined', players[socket.id]);

    console.log(`👤 ${data.name} se unió. Total: ${Object.keys(players).length}`);
  });

  // Actualización de posición (llega ~20 veces por segundo)
  socket.on('move', (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].facing = data.facing;
    players[socket.id].action = data.action || null;

    // Reenviar a todos menos al emisor
    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      x: data.x,
      y: data.y,
      facing: data.facing,
      action: data.action || null
    });
  });

  // Acción del mundo (cortar árbol, plantar, construir, etc.)
  socket.on('worldAction', (data) => {
    // Reenviar a todos (incluyendo al emisor para confirmar)
    io.emit('worldAction', { ...data, playerId: socket.id });
    console.log(`🌍 Acción: ${data.type} en (${data.col},${data.row})`);
  });

  // Chat
  socket.on('chat', (data) => {
    io.emit('chat', {
      name: players[socket.id]?.name || 'Desconocido',
      color: players[socket.id]?.color || '#fff',
      msg: data.msg.substring(0, 100) // limitar largo
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    if (players[socket.id]) {
      console.log(`❌ ${players[socket.id].name} se desconectó`);
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
