$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$state = [ordered]@{
  running   = $true
  kind      = 'think'
  label     = 'Thinking (probe)'
  detail    = 'Connectivity probe from PowerShell to the floating card.'
  startedAt = $now - 42000
} | ConvertTo-Json -Compress
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:17863/state' -Method POST -ContentType 'text/plain' -Body $state -UseBasicParsing -TimeoutSec 5
  Write-Output ("status=" + $r.StatusCode)
} catch {
  Write-Output ("err=" + $_.Exception.Message)
}
Start-Sleep -Milliseconds 500
Get-Content (Join-Path $env:TEMP 'dsh-live-thinking\overlay.log') -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 4
