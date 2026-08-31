// Límite de intentos fallidos de PIN (chofer y admin) por IP. Sin esto,
// alguien podría probar los ~9,000 PIN de 4 dígitos posibles con un script
// y "entrar" como cualquier chofer al azar — nada se lo impedía.
//
// Solo cuenta intentos FALLIDOS (PIN equivocado): un chofer que reintenta
// varias veces con el PIN correcto (o el admin, que reenvía su PIN en cada
// acción) nunca se bloquea. En memoria nomás — reiniciar el server limpia
// los contadores, y eso está bien para este caso de uso.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const MAX_FAILED_ATTEMPTS = 15;

const failedAttempts = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  let entry = failedAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    failedAttempts.set(ip, entry);
  }
  entry.count++;
}

function clearAttempts(ip) {
  failedAttempts.delete(ip);
}

const RATE_LIMIT_MESSAGE = "Demasiados intentos. Espera unos minutos e intenta de nuevo.";

module.exports = { isRateLimited, recordFailedAttempt, clearAttempts, RATE_LIMIT_MESSAGE };
