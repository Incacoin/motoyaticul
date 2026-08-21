const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const express = require("express");

if (fs.existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}

const driverRoutes = require("./routes/drivers");
const rideRoutes = require("./routes/rides");
const adminRoutes = require("./routes/admin");
const realtime = require("./realtime");

const app = express();
app.use(express.json({ limit: "5mb" }));

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.use("/api", driverRoutes);
app.use("/api", rideRoutes);
app.use("/api", adminRoutes);

const server = http.createServer(app);
realtime.attach(server);

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`MotoYa backend escuchando en http://localhost:${PORT}`);
});
