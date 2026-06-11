$ErrorActionPreference = "Continue"

$baseUrl = "http://localhost:3101"

try {
  Write-Host "[$(Get-Date -Format s)] Running scan..."
  Invoke-RestMethod "$baseUrl/api/scan" | Out-Null

  Start-Sleep -Seconds 5

  Write-Host "[$(Get-Date -Format s)] Running operator brief + notification check..."
  Invoke-RestMethod "$baseUrl/api/shadow/operator-brief?era=POST_CALIBRATION&resolve=1&paper=1" | Out-Null

  Write-Host "[$(Get-Date -Format s)] Done."
}
catch {
  Write-Host "[$(Get-Date -Format s)] ERROR:"
  Write-Host $_.Exception.Message
}