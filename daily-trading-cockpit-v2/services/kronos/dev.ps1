$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot ".venv\\Scripts\\python.exe"

if (-not (Test-Path $python)) {
  Write-Error "Kronos virtualenv is missing. Run .\\setup.ps1 in services\\kronos first, then retry npm run dev:full."
}

Write-Host "[KRONOS] Starting Uvicorn on port 8001..."
try {
    & $python -m uvicorn app.main:app --reload --port 8001
} catch {
    Write-Error "Failed to start Kronos: $_"
}
