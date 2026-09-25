(() => {
  "use strict";

  const path = window.location.pathname;
  const environment = path.startsWith("/testnet") ? "TESTNET" : path.startsWith("/live") ? "LIVE" : null;
  // Use the read-only host observer rather than either trading API. The VPS
  // filesystem is shared, and this stays available when an executor is not.
  const runtimeScript = "/assets/kronos-runtime.js";

  if (!environment) return;

  const bannerId = "kronos-vps-disk-headline";

  function ensureBanner() {
    let banner = document.getElementById(bannerId);
    if (banner) return banner;

    const root = document.getElementById("root");
    if (!root || !root.parentNode) return null;

    banner = document.createElement("section");
    banner.id = bannerId;
    banner.hidden = true;
    banner.setAttribute("role", "alert");
    banner.setAttribute("aria-live", "assertive");
    banner.style.cssText = [
      "position:sticky",
      "top:0",
      "z-index:2147483647",
      "margin:0",
      "padding:12px 18px",
      "background:#7f1d1d",
      "border-bottom:2px solid #fca5a5",
      "color:#fff7ed",
      "font:600 14px/1.35 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "letter-spacing:.01em",
      "box-shadow:0 4px 14px rgba(69,10,10,.35)",
    ].join(";");
    root.parentNode.insertBefore(banner, root);
    return banner;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`;
    if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  }

  function render(disk) {
    const banner = ensureBanner();
    if (!banner) return;

    const sourceReady = disk?.ok === true;
    banner.dataset.diskSource = sourceReady ? "live" : "unavailable";
    banner.dataset.diskCheckedAt = typeof disk?.checkedAt === "string" ? disk.checkedAt : "";
    if (!sourceReady) {
      banner.hidden = false;
      banner.style.background = "#78350f";
      banner.style.borderBottomColor = "#fcd34d";
      banner.textContent = `⚠ VPS DISK STATUS UNAVAILABLE · ${environment} · penggunaan disk tidak dapat diverifikasi.`;
      return;
    }

    const usedPercent = Math.trunc(Number(disk?.usedPercent));
    const thresholdPercent = Math.trunc(Number(disk?.thresholdPercent));
    const threshold = Number.isFinite(thresholdPercent) ? thresholdPercent : 95;
    const critical = disk?.ok === true
      && disk?.level === "CRITICAL"
      && Number.isFinite(usedPercent)
      && usedPercent >= threshold;

    if (!critical) {
      banner.hidden = true;
      banner.textContent = "";
      return;
    }

    banner.style.background = "#7f1d1d";
    banner.style.borderBottomColor = "#fca5a5";
    banner.hidden = false;
    banner.textContent = `⚠ VPS DISK CRITICAL · ${environment} · ${usedPercent}% terpakai · sisa ${formatBytes(Number(disk.availableBytes))} · ambang ${threshold}% · write/ledger bisa gagal.`;
  }

  function refresh() {
    const script = document.createElement("script");
    script.async = true;
    script.src = `${runtimeScript}?at=${Date.now()}`;
    script.onload = () => {
      render(window.__KRONOS_HOST_DISK__?.disk);
      script.remove();
    };
    script.onerror = () => {
      render(null);
      script.remove();
    };
    document.head.appendChild(script);
  }

  function start() {
    if (!ensureBanner()) {
      window.setTimeout(start, 50);
      return;
    }
    refresh();
    window.setInterval(refresh, 60_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
