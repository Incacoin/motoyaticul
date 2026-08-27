const express = require("express");
const db = require("../db");
const realtime = require("../realtime");

const router = express.Router();

router.post("/rides", (req, res) => {
  const {
    rider_name,
    rider_phone,
    pickup_lat,
    pickup_lng,
    pickup_label,
    dest_lat,
    dest_lng,
    dest_label,
    passengers,
    ride_type,
  } = req.body;

  if (!rider_name || !rider_phone || pickup_lat == null || pickup_lng == null) {
    return res.status(400).json({ error: "Faltan datos del viaje" });
  }

  db.prepare(
    `INSERT INTO riders (phone, name, last_ride_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(phone) DO UPDATE SET name = excluded.name, last_ride_at = excluded.last_ride_at`
  ).run(rider_phone, rider_name);
  const rider = db.prepare("SELECT id FROM riders WHERE phone = ?").get(rider_phone);

  const result = db
    .prepare(
      `INSERT INTO rides (rider_name, rider_phone, rider_id, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label, passengers, ride_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rider_name,
      rider_phone,
      rider.id,
      pickup_lat,
      pickup_lng,
      pickup_label || null,
      dest_lat ?? null,
      dest_lng ?? null,
      dest_label || null,
      passengers || 1,
      ride_type === "taxi" ? "taxi" : "moto"
    );

  const ride = db
    .prepare("SELECT * FROM rides WHERE id = ?")
    .get(result.lastInsertRowid);

  // Viajes completados anteriores de este mismo teléfono — para mostrarle
  // su propio contador/insignia de pasajero frecuente. Va pegado a la
  // creación del viaje (no es un endpoint público aparte) para no dejar
  // consultar el historial de cualquier número ajeno.
  const { trips: riderTripCount } = db
    .prepare(
      "SELECT COUNT(*) AS trips FROM rides WHERE rider_phone = ? AND status = 'completado'"
    )
    .get(rider_phone);

  realtime.broadcastNewRide(ride);
  realtime.startNoDriverTimer(ride.id);
  res.status(201).json({ ...ride, riderTripCount });
});

// Si un pasajero o chofer se quedó a medias (app cerrada, celular apagado,
// etc.) el viaje se queda "vivo" para siempre y nadie puede pedir uno nuevo
// ni el chofer vuelve a estar disponible. Cada vez que alguien consulta un
// viaje que ya lleva demasiado tiempo sin terminar, se da por abandonado
// aquí mismo — no hace falta un proceso aparte corriendo en segundo plano.
const ABANDONED_AFTER_MIN = 60;

router.get("/rides/:id", (req, res) => {
  let ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!ride) return res.status(404).json({ error: "Viaje no encontrado" });

  if (!["completado", "cancelado"].includes(ride.status)) {
    const { mins } = db
      .prepare(
        "SELECT (julianday('now') - julianday(created_at)) * 24 * 60 AS mins FROM rides WHERE id = ?"
      )
      .get(ride.id);
    if (mins > ABANDONED_AFTER_MIN) {
      db.prepare(
        "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?"
      ).run("system", `Abandonado automáticamente tras ${ABANDONED_AFTER_MIN} min sin completarse`, ride.id);
      if (ride.driver_id) {
        db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(ride.driver_id);
        realtime.notifyDriver(ride.driver_id, "ride_cancelled", { rideId: ride.id });
      }
      realtime.clearDisconnectTimer(ride.id);
      realtime.clearNoDriverTimer(ride.id);
      realtime.clearPreAcceptContact(ride.id);
      ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);
    }
  }

  if (ride.driver_id) {
    ride.driver = db
      .prepare(
        "SELECT id, name, phone, vehicle, grupo, lat, lng, photo FROM drivers WHERE id = ?"
      )
      .get(ride.driver_id);
  }
  res.json(ride);
});

router.post("/rides/:id/accept", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId } = req.body;
  if (!driverId) return res.status(400).json({ error: "Falta driverId" });

  const result = db
    .prepare(
      "UPDATE rides SET driver_id = ?, status = 'aceptado', updated_at = datetime('now') WHERE id = ? AND status = 'buscando'"
    )
    .run(driverId, rideId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "El viaje ya fue tomado" });
  }

  db.prepare("UPDATE drivers SET status = 'en_viaje' WHERE id = ?").run(
    driverId
  );
  realtime.clearNoDriverTimer(rideId);
  realtime.clearPreAcceptContact(rideId);

  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, grupo, lat, lng, photo FROM drivers WHERE id = ?"
    )
    .get(driverId);

  realtime.notifyRide(rideId, "ride_accepted", driver);
  realtime.broadcastRideTaken(rideId, driverId);
  res.json(ride);
});

router.post("/rides/:id/arrived", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId } = req.body;

  const result = db
    .prepare(
      "UPDATE rides SET status = 'llegue', updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'aceptado'"
    )
    .run(rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  realtime.notifyRide(rideId, "status_change", { status: "llegue" });
  res.json({ ok: true });
});

router.post("/rides/:id/start", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId } = req.body;

  const result = db
    .prepare(
      "UPDATE rides SET status = 'en_curso', updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'llegue'"
    )
    .run(rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  realtime.notifyRide(rideId, "status_change", { status: "en_curso" });
  res.json({ ok: true });
});

router.post("/rides/:id/complete", (req, res) => {
  const rideId = Number(req.params.id);
  const { driverId } = req.body;

  const result = db
    .prepare(
      "UPDATE rides SET status = 'completado', updated_at = datetime('now') WHERE id = ? AND driver_id = ? AND status = 'en_curso'"
    )
    .run(rideId, driverId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "No se pudo actualizar el viaje" });
  }

  db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(
    driverId
  );

  const { count: todayCount } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado' AND date(updated_at) = date('now')"
    )
    .get(driverId);

  const { count: lifetimeTrips } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado'"
    )
    .get(driverId);

  realtime.notifyRide(rideId, "status_change", { status: "completado" });
  res.json({ ok: true, todayCount, lifetimeTrips });
});

// Enfriamiento tras cancelación del chofer: si ya se había comprometido con un
// pasajero (driver_id asignado) y él mismo cancela, no vuelve a recibir
// solicitudes nuevas por unos minutos — le quita lo "gratis" a cancelar para
// irse con alguien que lo paró en la calle. Cancelaciones del pasajero no cuentan.
const DRIVER_CANCEL_COOLDOWN_MIN = 5;

router.post("/rides/:id/cancel", (req, res) => {
  const rideId = Number(req.params.id);
  const { cancelledBy, reason } = req.body || {};
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  if (!ride) return res.status(404).json({ error: "Viaje no encontrado" });

  db.prepare(
    "UPDATE rides SET status = 'cancelado', updated_at = datetime('now'), driver_disconnected_at = NULL, cancelled_by = ?, cancel_reason = ? WHERE id = ?"
  ).run(cancelledBy || null, reason || null, rideId);
  realtime.clearDisconnectTimer(rideId);
  realtime.clearNoDriverTimer(rideId);
  realtime.clearPreAcceptContact(rideId);

  let cooldownUntil = null;
  if (ride.driver_id) {
    if (cancelledBy === "driver") {
      cooldownUntil = db
        .prepare(`SELECT datetime('now', '+${DRIVER_CANCEL_COOLDOWN_MIN} minutes') AS cu`)
        .get().cu;
      db.prepare(
        "UPDATE drivers SET status = 'disponible', cancel_count = cancel_count + 1, cooldown_until = ? WHERE id = ?"
      ).run(cooldownUntil, ride.driver_id);
    } else {
      db.prepare("UPDATE drivers SET status = 'disponible' WHERE id = ?").run(
        ride.driver_id
      );
    }
    realtime.notifyDriver(ride.driver_id, "ride_cancelled", { rideId });
  } else {
    realtime.broadcastRideRemoved(rideId);
  }

  realtime.notifyRide(rideId, "status_change", { status: "cancelado" });
  res.json({ ok: true, cooldownUntil });
});

router.post("/rides/:id/rate", (req, res) => {
  const rideId = Number(req.params.id);
  const { rating } = req.body;
  if (rating !== 0 && rating !== 1) {
    return res.status(400).json({ error: "Calificación inválida" });
  }

  const result = db
    .prepare(
      "UPDATE rides SET rating = ? WHERE id = ? AND status = 'completado' AND rating IS NULL"
    )
    .run(rating, rideId);

  if (result.changes === 0) {
    return res.status(409).json({ error: "Este viaje ya fue calificado o no se puede calificar" });
  }

  res.json({ ok: true });
});

module.exports = router;
