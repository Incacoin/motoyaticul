const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { LAUNCH_DATE } = require("./constants");

const dbPath = path.join(__dirname, "data", "motoya.db");
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    vehicle TEXT,
    pin TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'offline',
    lat REAL,
    lng REAL,
    last_seen TEXT,
    paid_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rider_name TEXT NOT NULL,
    rider_phone TEXT NOT NULL,
    pickup_lat REAL NOT NULL,
    pickup_lng REAL NOT NULL,
    pickup_label TEXT,
    dest_lat REAL,
    dest_lng REAL,
    dest_label TEXT,
    passengers INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'buscando',
    driver_id INTEGER REFERENCES drivers(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS driver_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    photo TEXT,
    status TEXT NOT NULL DEFAULT 'pendiente',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS driver_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    amount REAL NOT NULL,
    period_start TEXT,
    period_end TEXT,
    paid_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try {
  db.exec("ALTER TABLE drivers ADD COLUMN paid_until TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN vouched_by TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN vouched_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN passengers INTEGER NOT NULL DEFAULT 1");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN driver_disconnected_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN deleted_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN tipo TEXT NOT NULL DEFAULT 'informal'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN photo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN accepted_legal_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN accepted_legal_version TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN rating INTEGER");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN accepted_legal_at TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN accepted_legal_version TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN photo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'moto'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN ride_type TEXT NOT NULL DEFAULT 'moto'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'moto'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN grupo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_applications ADD COLUMN tipo TEXT NOT NULL DEFAULT 'informal'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN cancelled_by TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN cancel_reason TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN cancel_count INTEGER NOT NULL DEFAULT 0");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN cooldown_until TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE drivers ADD COLUMN grupo TEXT");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE rides ADD COLUMN fee_settled_at TEXT");
} catch {
  // la columna ya existe
}

// Los viajes completados antes de LAUNCH_DATE son de antes de que existiera
// la cuota de $2/viaje — se marcan como ya liquidados para que no aparezcan
// como "viajes sin cobrar" la primera vez que carga el admin con esta feature.
db.prepare(
  "UPDATE rides SET fee_settled_at = updated_at WHERE status = 'completado' AND fee_settled_at IS NULL AND date(updated_at) < date(?)"
).run(LAUNCH_DATE);

try {
  db.exec("ALTER TABLE driver_payments ADD COLUMN concept TEXT NOT NULL DEFAULT 'mensual'");
} catch {
  // la columna ya existe
}

try {
  db.exec("ALTER TABLE driver_payments ADD COLUMN ride_count INTEGER");
} catch {
  // la columna ya existe
}

db.exec(`
  CREATE TABLE IF NOT EXISTS riders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ride_at TEXT
  );
`);

try {
  db.exec("ALTER TABLE rides ADD COLUMN rider_id INTEGER REFERENCES riders(id)");
} catch {
  // la columna ya existe
}

// Backfill: da de alta un rider por cada teléfono que ya aparece en viajes
// viejos (de antes de que existiera esta tabla) y liga esos viajes con su
// rider_id. Es idempotente: solo toca teléfonos/viajes que aún no tienen dueño.
db.exec(`
  INSERT OR IGNORE INTO riders (phone, name, created_at, last_ride_at)
  SELECT rider_phone, rider_name, MIN(created_at), MAX(created_at)
  FROM rides
  GROUP BY rider_phone;

  UPDATE rides
  SET rider_id = (SELECT id FROM riders WHERE riders.phone = rides.rider_phone)
  WHERE rider_id IS NULL;
`);

module.exports = db;
