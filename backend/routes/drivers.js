const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION, MAX_MATCH_DISTANCE_KM, SERVICE_CENTER, DRIVER_STALE_SECONDS, SERVICE_FEE, MONTHLY_FEE } = require("../constants");
const { haversineKm } = require("../geo");

const router = express.Router();

// Fuente única de las cuotas para los 3 frontends (pasajero, chofer, admin)
// — evita que se desincronicen del valor real que se cobra.
router.get("/config", (req, res) => {
  res.json({ serviceFee: SERVICE_FEE, monthlyFee: MONTHLY_FEE });
});

// Choferes "disponibles" de verdad: con GPS reciente (no fantasmas de una
// sesión que se quedó abierta) y cerca de quien está mirando el mapa (un
// chofer en Ticul no le sirve de nada a un pasajero en Tekax).
router.get("/drivers/available", (req, res) => {
  const type = req.query.type === "taxi" ? "taxi" : "moto";
  const refLat = Number(req.query.lat);
  const refLng = Number(req.query.lng);
  const hasRef = Number.isFinite(refLat) && Number.isFinite(refLng);
  const ref = hasRef ? { lat: refLat, lng: refLng } : SERVICE_CENTER;

  const drivers = db
    .prepare(
      `SELECT id, name, lat, lng, vehicle_type FROM drivers
       WHERE status = 'disponible' AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL
         AND vehicle_type = ?
         AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
         AND last_seen >= datetime('now', '-${DRIVER_STALE_SECONDS} seconds')`
    )
    .all(type);

  const nearby = drivers.filter(
    (d) => haversineKm(ref.lat, ref.lng, d.lat, d.lng) <= MAX_MATCH_DISTANCE_KM
  );
  res.json(nearby);
});

// Insignia de "top chofer": los 3 con más viajes en los últimos 30 días,
// pero solo entre los que además tienen buena calificación — así no gana
// solo por volumen alguien con mala fama. Requiere mínimo de viajes y de
// calificaciones recibidas para no premiar una racha de suerte con 1-2 viajes.
router.get("/drivers/ranking", (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.name,
              COUNT(r.id) AS trips,
              SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS thumbsUp,
              SUM(CASE WHEN r.rating IS NOT NULL THEN 1 ELSE 0 END) AS ratedCount
       FROM drivers d
       JOIN rides r ON r.driver_id = d.id AND r.status = 'completado' AND date(r.updated_at) >= date('now', '-30 days')
       WHERE d.deleted_at IS NULL
       GROUP BY d.id
       HAVING trips >= 5 AND ratedCount >= 3 AND (thumbsUp * 1.0 / ratedCount) >= 0.8
       ORDER BY trips DESC, (thumbsUp * 1.0 / ratedCount) DESC
       LIMIT 3`
    )
    .all();

  res.json(
    rows.map((r, i) => ({
      id: r.id,
      name: r.name,
      rank: i + 1,
      trips: r.trips,
      ratingPct: Math.round((r.thumbsUp / r.ratedCount) * 100),
    }))
  );
});

router.post("/drivers/login", (req, res) => {
  const { pin } = req.body;
  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, vehicle_type, status, cooldown_until FROM drivers WHERE pin = ? AND deleted_at IS NULL"
    )
    .get(pin);

  if (!driver) {
    return res.status(404).json({ error: "PIN no encontrado" });
  }

  const { count: todayCount } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado' AND date(updated_at) = date('now')"
    )
    .get(driver.id);

  const { count: lifetimeTrips } = db
    .prepare(
      "SELECT COUNT(*) as count FROM rides WHERE driver_id = ? AND status = 'completado'"
    )
    .get(driver.id);

  res.json({ ...driver, todayCount, lifetimeTrips });
});

router.post("/chofer-solicitudes", (req, res) => {
  const { name, phone, photo, acceptedLegal, vehicleType } = req.body;
  if (!name || !phone || !photo) {
    return res.status(400).json({ error: "Falta nombre, teléfono o foto" });
  }
  if (!acceptedLegal) {
    return res.status(400).json({ error: "Debes aceptar el aviso legal para continuar" });
  }

  db.prepare(
    "INSERT INTO driver_applications (name, phone, photo, accepted_legal_at, accepted_legal_version, vehicle_type) VALUES (?, ?, ?, datetime('now'), ?, ?)"
  ).run(name, phone, photo, AVISO_LEGAL_VERSION, vehicleType === "taxi" ? "taxi" : "moto");
  res.status(201).json({ ok: true });
});

module.exports = router;
