const { WebSocketServer } = require("ws");
const url = require("node:url");
const db = require("./db");

// driverId -> WebSocket
const driverSockets = new Map();
// rideId -> Set<WebSocket>
const rideSubscribers = new Map();
// rideId -> Timeout (cuenta regresiva de "chofer desconectado" -> "chofer perdido")
const disconnectTimers = new Map();
// rideId -> Timeout (cuenta regresiva de "nadie ha aceptado el viaje")
const noDriverTimers = new Map();
// rideId -> driverId: quién le escribió al pasajero antes de aceptar el viaje
// (para poder enrutar su respuesta), se limpia al aceptar/cancelar/completar.
const preAcceptContact = new Map();

// Ventana de gracia antes de avisarle al pasajero que el chofer no vuelve.
// Cubre un parpadeo normal de señal (el chofer reconecta solo, en ~2s) sin
// alarmar al pasajero de más; si pasa esto, algo de verdad se cayó.
const DISCONNECT_GRACE_MS = 20000;

// Cuánto esperar después de crear un viaje antes de avisarle al pasajero que
// no hay choferes disponibles. Si se queda "buscando" más de esto sin que
// nadie lo acepte, probablemente no hay oferta suficiente en ese momento.
const NO_DRIVER_GRACE_MS = 60000;

// Un chofer normalmente solo tiene un viaje activo a la vez, pero si su app se
// recargó a medio viaje (pantalla apagada, refresh) el viaje viejo se queda
// "aceptado" en la base aunque el chofer ya siga con otro. ORDER BY id DESC
// asegura que siempre agarremos el viaje que el chofer está atendiendo de
// verdad (el más reciente), no un viaje fantasma abandonado.
function activeRideForDriver(driverId) {
  return db
    .prepare(
      "SELECT id, driver_disconnected_at FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso') ORDER BY id DESC LIMIT 1"
    )
    .get(driverId);
}

function handleDriverDisconnected(driverId) {
  const ride = activeRideForDriver(driverId);
  if (!ride) return;

  db.prepare("UPDATE rides SET driver_disconnected_at = datetime('now') WHERE id = ?").run(ride.id);
  notifyRide(ride.id, "driver_disconnected", {});

  const timer = setTimeout(() => {
    disconnectTimers.delete(ride.id);
    const current = db
      .prepare("SELECT status, driver_disconnected_at FROM rides WHERE id = ?")
      .get(ride.id);
    const stillStuck =
      current &&
      ["aceptado", "llegue", "en_curso"].includes(current.status) &&
      current.driver_disconnected_at &&
      !driverSockets.has(driverId);
    if (stillStuck) notifyRide(ride.id, "driver_lost", {});
  }, DISCONNECT_GRACE_MS);
  disconnectTimers.set(ride.id, timer);
}

function handleDriverReconnected(driverId) {
  const ride = activeRideForDriver(driverId);
  if (!ride || !ride.driver_disconnected_at) return;

  db.prepare("UPDATE rides SET driver_disconnected_at = NULL WHERE id = ?").run(ride.id);
  const timer = disconnectTimers.get(ride.id);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(ride.id);
  }
  notifyRide(ride.id, "driver_reconnected", {});
}

function startNoDriverTimer(rideId) {
  const timer = setTimeout(() => {
    noDriverTimers.delete(rideId);
    const ride = db.prepare("SELECT status FROM rides WHERE id = ?").get(rideId);
    if (!ride || ride.status !== "buscando") return;

    db.prepare(
      "UPDATE rides SET status = 'cancelado', updated_at = datetime('now') WHERE id = ?"
    ).run(rideId);
    notifyRide(rideId, "no_drivers_available", {});
    broadcastRideRemoved(rideId);
  }, NO_DRIVER_GRACE_MS);
  noDriverTimers.set(rideId, timer);
}

function clearNoDriverTimer(rideId) {
  const timer = noDriverTimers.get(rideId);
  if (timer) {
    clearTimeout(timer);
    noDriverTimers.delete(rideId);
  }
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const { query } = url.parse(req.url, true);

    if (query.role === "driver") {
      const driverId = Number(query.driverId);
      const driver = driverId
        ? db.prepare("SELECT id FROM drivers WHERE id = ?").get(driverId)
        : null;
      if (!driver) {
        ws.close(4004, "unknown driver");
        return;
      }

      const existing = driverSockets.get(driverId);
      if (existing && existing.readyState === existing.OPEN) {
        existing.close(4001, "logged in elsewhere");
      }

      driverSockets.set(driverId, ws);
      handleDriverReconnected(driverId);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "location") {
          const { lat, lng } = msg;
          db.prepare(
            "UPDATE drivers SET lat = ?, lng = ?, last_seen = datetime('now') WHERE id = ?"
          ).run(lat, lng, driverId);

          const activeRide = activeRideForDriver(driverId);
          if (activeRide) {
            notifyRide(activeRide.id, "driver_location", { lat, lng });
          }
        } else if (msg.type === "status") {
          db.prepare("UPDATE drivers SET status = ? WHERE id = ?").run(
            msg.status,
            driverId
          );
        } else if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
          const text = msg.text.trim().slice(0, 300);
          if (msg.rideId) {
            // Mensaje a una solicitud pendiente (todavía no aceptada) desde
            // la lista de viajes cercanos — validar que sigue disponible o
            // que ya es del propio chofer, para no dejar escribirle a
            // pasajeros de viajes de otros choferes.
            const rideId = Number(msg.rideId);
            const ride = db
              .prepare("SELECT id, driver_id, status FROM rides WHERE id = ?")
              .get(rideId);
            if (!ride) return;
            if (ride.driver_id && ride.driver_id !== driverId) return;
            if (!["buscando", "aceptado", "llegue", "en_curso"].includes(ride.status)) return;
            if (!ride.driver_id) preAcceptContact.set(rideId, driverId);
            notifyRide(rideId, "chat", { text });
          } else {
            const ride = activeRideForDriver(driverId);
            if (ride) notifyRide(ride.id, "chat", { text });
          }
        }
      });

      ws.on("close", () => {
        if (driverSockets.get(driverId) === ws) {
          driverSockets.delete(driverId);
          db.prepare(
            "UPDATE drivers SET status = 'offline' WHERE id = ?"
          ).run(driverId);
          handleDriverDisconnected(driverId);
        }
      });
      return;
    }

    if (query.role === "rider") {
      const rideId = Number(query.rideId);
      const ride = rideId
        ? db.prepare("SELECT id FROM rides WHERE id = ?").get(rideId)
        : null;
      if (!ride) {
        ws.close(4004, "unknown ride");
        return;
      }

      if (!rideSubscribers.has(rideId)) rideSubscribers.set(rideId, new Set());
      rideSubscribers.get(rideId).add(ws);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
          const current = db.prepare("SELECT driver_id FROM rides WHERE id = ?").get(rideId);
          const targetDriverId = current?.driver_id || preAcceptContact.get(rideId);
          if (targetDriverId) {
            notifyDriver(targetDriverId, "chat", { text: msg.text.trim().slice(0, 300) });
          }
        }
      });

      ws.on("close", () => {
        rideSubscribers.get(rideId)?.delete(ws);
      });
      return;
    }

    ws.close(4000, "missing role");
  });

  return wss;
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function notifyRide(rideId, type, payload) {
  const clients = rideSubscribers.get(rideId);
  if (!clients) return;
  for (const ws of clients) send(ws, type, payload);
}

function broadcastNewRide(ride) {
  const rideType = ride.ride_type === "taxi" ? "taxi" : "moto";
  const available = db
    .prepare(
      "SELECT id FROM drivers WHERE status = 'disponible' AND vehicle_type = ? AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))"
    )
    .all(rideType);
  for (const { id } of available) {
    const ws = driverSockets.get(id);
    if (ws) send(ws, "new_ride", ride);
  }
}

function broadcastRideTaken(rideId, winningDriverId) {
  for (const [driverId, ws] of driverSockets) {
    if (driverId !== winningDriverId) send(ws, "ride_taken", { rideId });
  }
}

function broadcastRideRemoved(rideId) {
  for (const ws of driverSockets.values()) send(ws, "ride_taken", { rideId });
}

function notifyDriver(driverId, type, payload) {
  const ws = driverSockets.get(driverId);
  if (ws) send(ws, type, payload);
}

function clearDisconnectTimer(rideId) {
  const timer = disconnectTimers.get(rideId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(rideId);
  }
}

function clearPreAcceptContact(rideId) {
  preAcceptContact.delete(rideId);
}

module.exports = {
  attach,
  notifyRide,
  broadcastNewRide,
  clearPreAcceptContact,
  broadcastRideTaken,
  broadcastRideRemoved,
  notifyDriver,
  clearDisconnectTimer,
  startNoDriverTimer,
  clearNoDriverTimer,
};
