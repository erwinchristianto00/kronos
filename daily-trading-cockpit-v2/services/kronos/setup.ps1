$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
  python -m venv .venv
}

& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt

Write-Host "Kronos environment is ready. Start with:"
Write-Host ".\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001"
