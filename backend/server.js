const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");

if (fs.existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}

const db = require("./db");
const driverRoutes = require("./routes/drivers");
const rideRoutes = require("./routes/rides");
const adminRoutes = require("./routes/admin");
const realtime = require("./realtime");
const { startBackupSchedule } = require("./backup");

const app = express();
// Render (y cualquier proxy delante del server) reenvía la IP real del
// cliente en X-Forwarded-For — sin esto, req.ip siempre sería la IP interna
// del proxy y el límite de intentos de PIN no distinguiría a nadie.
app.set("trust proxy", true);
app.use(express.json({ limit: "5mb" }));

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/api/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error" });
  }
});

app.use("/api", driverRoutes);
app.use("/api", rideRoutes);
app.use("/api", adminRoutes);

startBackupSchedule(6);

const server = http.createServer(app);
realtime.attach(server);

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`MotoYa backend escuchando en http://localhost:${PORT}`);
});
