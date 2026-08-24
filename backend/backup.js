const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "data");
const BACKUP_REPO = process.env.BACKUP_GITHUB_REPO;
const BACKUP_TOKEN = process.env.BACKUP_GITHUB_TOKEN;
const APP_NAME = process.env.BACKUP_APP_NAME || "motoyaticul";

const SKIP_SUFFIXES = [".db-journal", ".db-wal", ".db-shm"];

function listFilesRecursive(dir, base = dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listFilesRecursive(full, base));
    } else if (entry.isFile() && !SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

async function putFile(relPath, content, weekday) {
  const target = `${APP_NAME}/backup-${weekday}/${relPath}`;
  const apiUrl = `https://api.github.com/repos/${BACKUP_REPO}/contents/${target}`;
  const headers = {
    Authorization: `Bearer ${BACKUP_TOKEN}`,
    "User-Agent": "motoya-backup",
  };

  let sha;
  const existing = await fetch(apiUrl, { headers });
  if (existing.ok) {
    sha = (await existing.json()).sha;
  }

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Respaldo automático ${APP_NAME} — ${weekday} ${new Date().toISOString()}`,
      content,
      sha,
    }),
  });

  if (!res.ok) {
    throw new Error(`${target}: ${res.status} ${await res.text()}`);
  }
}

async function backupOnce() {
  if (!BACKUP_REPO || !BACKUP_TOKEN) {
    console.warn("[backup] BACKUP_GITHUB_REPO/BACKUP_GITHUB_TOKEN no configurados — respaldo desactivado");
    return;
  }
  if (!fs.existsSync(DATA_DIR)) return;

  const weekday = new Date()
    .toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Merida" })
    .toLowerCase();
  const files = listFilesRecursive(DATA_DIR);

  let ok = 0;
  for (const relPath of files) {
    try {
      const content = fs.readFileSync(path.join(DATA_DIR, relPath)).toString("base64");
      await putFile(relPath, content, weekday);
      ok++;
    } catch (err) {
      console.error(`[backup] fallo en ${relPath}:`, err.message);
    }
  }
  console.log(`[backup] respaldo "${weekday}" completado (${ok}/${files.length} archivo(s))`);
}

function startBackupSchedule(intervalHours = 6) {
  backupOnce();
  setInterval(backupOnce, intervalHours * 60 * 60 * 1000);
}

module.exports = { startBackupSchedule, backupOnce };
