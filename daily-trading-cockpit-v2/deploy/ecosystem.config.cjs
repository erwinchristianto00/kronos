// pm2 process definitions. Start with:  pm2 start deploy/ecosystem.config.cjs
// Then persist across reboots:  pm2 save && pm2 startup  (run the line it prints).
//
// Set KRONOS_ENABLED=0 in the environment before `pm2 start` to skip Kronos on a
// small (1–2GB) box — the scan runs fine without it (Kronos just goes weightless).
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
  },
  {
    name: "dtc-web",
    script: path.join(__dirname, "run-web.sh"),
    interpreter: "bash",
    autorestart: true,
    max_restarts: 100,
    restart_delay: 5000,
    time: true,
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
  });
}

module.exports = { apps };
