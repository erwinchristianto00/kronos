// pm2 process definitions. Start with:  pm2 start deploy/ecosystem.config.cjs
// Then persist across reboots:  pm2 save && pm2 startup  (run the line it prints).
//
// Set KRONOS_ENABLED=0 in the environment before `pm2 start` to skip Kronos on a
// small (1–2GB) box — the scan runs fine without it (Kronos just goes weightless).
//
// max_memory_restart is a soft ceiling: pm2 sends a graceful restart (not a hard
// system OOM-kill) once RSS crosses it. NODE_OPTIONS caps the V8 heap itself,
// below the RSS ceiling, so a leak surfaces as a catchable/loggable V8 condition
// before the OS ever has to intervene. Sized for a 7.8GB box running all 3
// api instances + web + kronos side by side (worst case ~4.6GB, leaves ~3GB free).
const path = require("node:path");

const apps = [
  {
    name: "dtc-api",
    script: path.join(__dirname, "run-api.sh"),
    interpreter: "bash",
    autorestart: true,
    max_restarts: 100,
    restart_delay: 5000,
    time: true,
    max_memory_restart: "768M",
    env: { NODE_OPTIONS: "--max-old-space-size=512" },
  },
  {
    name: "dtc-web",
    script: path.join(__dirname, "run-web.sh"),
    interpreter: "bash",
    autorestart: true,
    max_restarts: 100,
    restart_delay: 5000,
    time: true,
    max_memory_restart: "384M",
    env: { NODE_OPTIONS: "--max-old-space-size=256" },
  },
];

if (process.env.KRONOS_ENABLED !== "0") {
  apps.push({
    name: "kronos",
    script: path.join(__dirname, "run-kronos.sh"),
    interpreter: "bash",
    autorestart: true,
    max_restarts: 50,
    restart_delay: 10000,
    time: true,
    max_memory_restart: "2048M",
  });
}

module.exports = { apps };
