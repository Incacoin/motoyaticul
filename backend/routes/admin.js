const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION } = require("../constants");

const router = express.Router();

function checkAdminPin(req, res, next) {
  if (req.body.adminPin !== process.env.ADMIN_PIN) {
    return res.status(401).json({ error: "PIN de admin incorrecto" });
  }
  next();
}

function generateDriverPin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (db.prepare("SELECT id FROM drivers WHERE pin = ?").get(pin));
  return pin;
}

router.post("/admin/login", (req, res) => {
  if (req.body.adminPin !== process.env.ADMIN_PIN) {
    return res.status(401).json({ error: "PIN de admin incorrecto" });
  }
  res.json({ ok: true });
});

router.post("/admin/drivers", checkAdminPin, (req, res) => {
  const { name, phone, vehicle, tipo, acceptedLegal, photo, vehicleType, grupo } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Falta nombre o teléfono" });
  }
  if (!acceptedLegal) {
    return res.status(400).json({ error: "Confirma que el chofer aceptó el aviso legal" });
  }

  const existingPhone = db
    .prepare("SELECT id, name FROM drivers WHERE phone = ? AND deleted_at IS NULL")
    .get(phone);
  if (existingPhone) {
    return res.status(409).json({
      error: `Ese teléfono ya está registrado con el chofer "${existingPhone.name}"`,
    });
  }

  const existingName = db
    .prepare("SELECT id FROM drivers WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL")
    .get(name);
  if (existingName) {
    return res.status(409).json({
      error: `Ya hay un chofer registrado con el nombre "${name}"`,
    });
  }

  const pin = generateDriverPin();
  const result = db
    .prepare(
      "INSERT INTO drivers (name, phone, vehicle, pin, tipo, accepted_legal_at, accepted_legal_version, photo, vehicle_type, grupo) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)"
    )
    .run(name, phone, vehicle || null, pin, tipo === "formal" ? "formal" : "informal", AVISO_LEGAL_VERSION, photo || null, vehicleType === "taxi" ? "taxi" : "moto", grupo || null);

  const driver = db
    .prepare("SELECT id, name, phone, vehicle, pin, status, tipo, photo, vehicle_type, grupo FROM drivers WHERE id = ?")
    .get(result.lastInsertRowid);

  res.status(201).json(driver);
});

router.post("/admin/drivers/list", checkAdminPin, (req, res) => {
  const drivers = db
    .prepare(
      "SELECT id, name, phone, vehicle, pin, status, last_seen, paid_until, vouched_by, vouched_at, tipo, photo, vehicle_type, cancel_count, cooldown_until, grupo, created_at FROM drivers WHERE deleted_at IS NULL ORDER BY created_at DESC"
    )
    .all();
  res.json(drivers);
});

router.post("/admin/drivers/:id/paid-until", checkAdminPin, (req, res) => {
  const { paidUntil } = req.body;
  db.prepare("UPDATE drivers SET paid_until = ? WHERE id = ?").run(
    paidUntil || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/drivers/:id/vouch", checkAdminPin, (req, res) => {
  const { vouchedBy } = req.body;
  const vouchedAt = vouchedBy ? new Date().toISOString().slice(0, 10) : null;
  db.prepare("UPDATE drivers SET vouched_by = ?, vouched_at = ? WHERE id = ?").run(
    vouchedBy || null,
    vouchedAt,
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/drivers/:id/update", checkAdminPin, (req, res) => {
  const { name, phone, vehicle, tipo, vehicleType, grupo } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Falta nombre o teléfono" });
  }

  const existingPhone = db
    .prepare("SELECT id, name FROM drivers WHERE phone = ? AND deleted_at IS NULL AND id != ?")
    .get(phone, req.params.id);
  if (existingPhone) {
    return res.status(409).json({
      error: `Ese teléfono ya está registrado con el chofer "${existingPhone.name}"`,
    });
  }

  const existingName = db
    .prepare("SELECT id FROM drivers WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL AND id != ?")
    .get(name, req.params.id);
  if (existingName) {
    return res.status(409).json({
      error: `Ya hay un chofer registrado con el nombre "${name}"`,
    });
  }

  db.prepare(
    "UPDATE drivers SET name = ?, phone = ?, vehicle = ?, tipo = ?, vehicle_type = ?, grupo = ? WHERE id = ?"
  ).run(name, phone, vehicle || null, tipo === "formal" ? "formal" : "informal", vehicleType === "taxi" ? "taxi" : "moto", grupo || null, req.params.id);

  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, pin, status, last_seen, paid_until, tipo, vehicle_type, grupo, created_at FROM drivers WHERE id = ?"
    )
    .get(req.params.id);
  res.json(driver);
});

router.post("/admin/drivers/:id/delete", checkAdminPin, (req, res) => {
  const activeRide = db
    .prepare("SELECT id FROM rides WHERE driver_id = ? AND status IN ('aceptado', 'llegue', 'en_curso')")
    .get(req.params.id);
  if (activeRide) {
    return res.status(409).json({ error: "Este chofer tiene un viaje activo en este momento, no se puede eliminar todavía" });
  }
  // Soft delete: conserva la fila (y su nombre en el historial de viajes),
  // solo lo saca de la lista de choferes activos y le cierra el acceso.
  db.prepare("UPDATE drivers SET deleted_at = datetime('now'), status = 'offline' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/admin/chofer-solicitudes/list", checkAdminPin, (req, res) => {
  const apps = db
    .prepare(
      "SELECT id, name, phone, photo, status, created_at, accepted_legal_at, accepted_legal_version, vehicle_type FROM driver_applications WHERE status = 'pendiente' ORDER BY created_at DESC"
    )
    .all();
  res.json(apps);
});

router.post("/admin/chofer-solicitudes/:id/dismiss", checkAdminPin, (req, res) => {
  db.prepare("UPDATE driver_applications SET status = 'descartada' WHERE id = ?").run(
    req.params.id
  );
  res.json({ ok: true });
});

router.post("/admin/rides/list", checkAdminPin, (req, res) => {
  const rides = db
    .prepare(
      `SELECT r.id, r.rider_name, r.rider_phone, r.pickup_label, r.dest_label,
              r.passengers, r.status, r.created_at, r.updated_at, r.driver_disconnected_at, r.rating, r.ride_type,
              r.cancelled_by, r.cancel_reason,
              d.name AS driver_name
       FROM rides r
       LEFT JOIN drivers d ON d.id = r.driver_id
       ORDER BY r.updated_at DESC
       LIMIT 50`
    )
    .all();
  res.json(rides);
});

router.post("/admin/rides/reset", checkAdminPin, (req, res) => {
  db.exec("DELETE FROM rides");
  res.json({ ok: true });
});

router.post("/admin/stats", checkAdminPin, (req, res) => {
  const ridesToday = db
    .prepare("SELECT COUNT(*) AS n FROM rides WHERE status = 'completado' AND date(updated_at) = date('now')")
    .get().n;
  const ridesWeek = db
    .prepare("SELECT COUNT(*) AS n FROM rides WHERE status = 'completado' AND date(updated_at) >= date('now', '-6 days')")
    .get().n;
  const cancelledToday = db
    .prepare("SELECT COUNT(*) AS n FROM rides WHERE status = 'cancelado' AND date(updated_at) = date('now')")
    .get().n;
  const driversOnline = db
    .prepare("SELECT COUNT(*) AS n FROM drivers WHERE status IN ('disponible', 'en_viaje') AND deleted_at IS NULL")
    .get().n;
  const topDrivers = db
    .prepare(
      `SELECT d.name, COUNT(*) AS rides
       FROM rides r JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'completado' AND date(r.updated_at) >= date('now', '-6 days')
       GROUP BY r.driver_id
       ORDER BY rides DESC
       LIMIT 5`
    )
    .all();
  const ratings = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(rating) AS good
       FROM rides
       WHERE rating IS NOT NULL AND date(updated_at) >= date('now', '-6 days')`
    )
    .get();
  const satisfactionPct = ratings.total > 0 ? Math.round((ratings.good / ratings.total) * 100) : null;

  res.json({ ridesToday, ridesWeek, cancelledToday, driversOnline, topDrivers, satisfactionPct, ratedCount: ratings.total });
});

module.exports = router;
