const express = require("express");
const db = require("../db");
const { AVISO_LEGAL_VERSION } = require("../constants");

const router = express.Router();

router.get("/drivers/available", (req, res) => {
  const type = req.query.type === "taxi" ? "taxi" : null;
  const drivers = type
    ? db
        .prepare(
          "SELECT id, name, lat, lng, vehicle_type FROM drivers WHERE status = 'disponible' AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL AND vehicle_type = ?"
        )
        .all(type)
    : db
        .prepare(
          "SELECT id, name, lat, lng, vehicle_type FROM drivers WHERE status = 'disponible' AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL AND vehicle_type = 'moto'"
        )
        .all();
  res.json(drivers);
});

router.post("/drivers/login", (req, res) => {
  const { pin } = req.body;
  const driver = db
    .prepare(
      "SELECT id, name, phone, vehicle, vehicle_type, status FROM drivers WHERE pin = ? AND deleted_at IS NULL"
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

  res.json({ ...driver, todayCount });
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
