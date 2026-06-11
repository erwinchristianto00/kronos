$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$envFile = Join-Path $repoRoot ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }

    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) {
      return
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

if (-not $env:KRONOS_BASE_URL) {
  [System.Environment]::SetEnvironmentVariable("KRONOS_BASE_URL", "http://localhost:8001", "Process")
}

if (-not $env:SOCIAL_SENTIMENT_PROVIDER) {
  [System.Environment]::SetEnvironmentVariable("SOCIAL_SENTIMENT_PROVIDER", "none", "Process")
}

$python = Join-Path $repoRoot "services\\kronos\\.venv\\Scripts\\python.exe"
if (-not (Test-Path $python)) {
    Write-Error "Kronos virtualenv is missing. Run .\services\kronos\setup.ps1 first, then retry npm run dev:full."
    exit 1
}

# Verify Kronos port isn't already occupied
$kronosPortOccupied = (Get-NetTCPConnection -LocalPort 8001 -ErrorAction SilentlyContinue) -ne $null
if ($kronosPortOccupied) {
    Write-Warning "Port 8001 is already in use. Kronos may conflict with another process."
}

& .\node_modules\.bin\kill-port.cmd 3101 5173 8001
& .\node_modules\.bin\concurrently.cmd `
  "npm run dev -w @dtc/api" `
  "npm run dev -w @dtc/web" `
  "powershell -ExecutionPolicy Bypass -File ./services/kronos/dev.ps1"
