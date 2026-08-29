const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION, SERVICE_FEE, LAUNCH_DATE, TRIAL_END_DATE } = require("../constants");

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
      `SELECT d.id, d.name, d.phone, d.vehicle, d.pin, d.status, d.last_seen, d.paid_until, d.vouched_by, d.vouched_at,
              d.tipo, d.photo, d.vehicle_type, d.cancel_count, d.cooldown_until, d.grupo, d.created_at,
              (SELECT amount FROM driver_payments WHERE driver_id = d.id ORDER BY paid_at DESC LIMIT 1) AS last_payment_amount,
              (SELECT paid_at FROM driver_payments WHERE driver_id = d.id ORDER BY paid_at DESC LIMIT 1) AS last_payment_at,
              (SELECT COUNT(*) FROM rides WHERE driver_id = d.id AND status = 'completado' AND fee_settled_at IS NULL) AS pending_rides
       FROM drivers d
       WHERE d.deleted_at IS NULL
       ORDER BY d.created_at DESC`
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

router.post("/admin/drivers/:id/register-payment", checkAdminPin, (req, res) => {
  const driver = db.prepare("SELECT id, paid_until FROM drivers WHERE id = ?").get(req.params.id);
  if (!driver) {
    return res.status(404).json({ error: "Chofer no encontrado" });
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const base = driver.paid_until && driver.paid_until > today ? driver.paid_until : today;
  const periodEnd = new Date(base);
  periodEnd.setDate(periodEnd.getDate() + 30);
  const periodEndStr = periodEnd.toISOString().slice(0, 10);

  db.prepare(
    "INSERT INTO driver_payments (driver_id, amount, period_start, period_end, concept) VALUES (?, ?, ?, ?, 'mensual')"
  ).run(req.params.id, amount, base, periodEndStr);
  db.prepare("UPDATE drivers SET paid_until = ? WHERE id = ?").run(periodEndStr, req.params.id);

  res.json({ ok: true, paidUntil: periodEndStr });
});

router.post("/admin/drivers/:id/pending-fees", checkAdminPin, (req, res) => {
  const { count } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
    )
    .get(req.params.id);
  res.json({ count, amount: count * SERVICE_FEE, feePerRide: SERVICE_FEE });
});

router.post("/admin/drivers/:id/register-trip-fees", checkAdminPin, (req, res) => {
  const pendingRides = db
    .prepare(
      "SELECT id FROM rides WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
    )
    .all(req.params.id);

  if (pendingRides.length === 0) {
    return res.status(400).json({ error: "No hay viajes pendientes de cobrar" });
  }

  const amount = pendingRides.length * SERVICE_FEE;
  db.prepare(
    "UPDATE rides SET fee_settled_at = datetime('now') WHERE driver_id = ? AND status = 'completado' AND fee_settled_at IS NULL"
  ).run(req.params.id);
  db.prepare(
    "INSERT INTO driver_payments (driver_id, amount, concept, ride_count) VALUES (?, ?, 'viajes', ?)"
  ).run(req.params.id, amount, pendingRides.length);

  res.json({ ok: true, count: pendingRides.length, amount });
});

router.post("/admin/drivers/:id/payments", checkAdminPin, (req, res) => {
  const payments = db
    .prepare(
      "SELECT id, amount, period_start, period_end, paid_at, concept, ride_count FROM driver_payments WHERE driver_id = ? ORDER BY paid_at DESC"
    )
    .all(req.params.id);
  res.json(payments);
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
      "SELECT id, name, phone, photo, status, created_at, accepted_legal_at, accepted_legal_version, vehicle_type, grupo, tipo FROM driver_applications WHERE status = 'pendiente' ORDER BY created_at DESC"
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
  const collectedWeek = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM driver_payments WHERE date(paid_at) >= date('now', '-6 days')")
    .get().total;
  const collectedMonth = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM driver_payments WHERE date(paid_at) >= date('now', '-29 days')")
    .get().total;
  const launchRanking = db
    .prepare(
      `SELECT d.id, d.name, COUNT(*) AS rides
       FROM rides r JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'completado' AND date(r.updated_at) >= date(?) AND (r.rating IS NULL OR r.rating = 1)
       GROUP BY r.driver_id
       ORDER BY rides DESC
       LIMIT 5`
    )
    .all(LAUNCH_DATE);

  res.json({
    ridesToday, ridesWeek, cancelledToday, driversOnline, topDrivers, satisfactionPct, ratedCount: ratings.total,
    collectedWeek, collectedMonth, launchRanking, trialEndDate: TRIAL_END_DATE,
  });
});

// Detecta el patrón de "cancela y te llevo por fuera": un chofer acepta un
// viaje, se pone de acuerdo con el pasajero por chat para que este cancele en
// la app, y el viaje se completa en efectivo sin que nunca llegue a
// "completado" — así nunca se acumula la cuota de $2/viaje. No hay forma de
// probarlo con certeza desde los datos (una cancelación real de pasajero se
// ve idéntica), así que esto es una señal para que el admin revise con el
// líder del gremio, no una acusación automática.
router.post("/admin/reports/cancelaciones", checkAdminPin, (req, res) => {
  const porChofer = db
    .prepare(
      `SELECT d.id, d.name, d.grupo,
              COUNT(*) AS total_asignados,
              SUM(CASE WHEN r.status = 'cancelado' AND r.cancelled_by = 'rider' THEN 1 ELSE 0 END) AS cancelados_pasajero
       FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       GROUP BY r.driver_id
       HAVING total_asignados >= 3 AND cancelados_pasajero > 0
       ORDER BY (1.0 * cancelados_pasajero / total_asignados) DESC
       LIMIT 20`
    )
    .all()
    .map((row) => ({ ...row, pct: Math.round((row.cancelados_pasajero / row.total_asignados) * 100) }));

  // La señal más fuerte: el mismo pasajero cancelando repetido justo con el
  // mismo chofer. Una cancelación real y aislada es normal; que se repita con
  // la misma pareja chofer-pasajero casi no pasa por accidente.
  const paresRepetidos = db
    .prepare(
      `SELECT r.driver_id, d.name AS driver_name, r.rider_phone, r.rider_name,
              COUNT(*) AS veces, MAX(r.updated_at) AS ultima_vez
       FROM rides r
       JOIN drivers d ON d.id = r.driver_id
       WHERE r.status = 'cancelado' AND r.cancelled_by = 'rider'
       GROUP BY r.driver_id, r.rider_phone
       HAVING veces >= 2
       ORDER BY veces DESC, ultima_vez DESC
       LIMIT 20`
    )
    .all();

  res.json({ porChofer, paresRepetidos });
});

module.exports = router;
