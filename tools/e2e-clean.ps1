param(
  [int[]]$Ports = @(3100, 5100)
)

$ErrorActionPreference = 'Stop'

function Get-ListeningPidsForPort {
  param([int]$Port)

  try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $connections) {
      return @()
    }
    return $connections | Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    return @()
  }
}

foreach ($port in $Ports) {
  $pids = Get-ListeningPidsForPort -Port $port

  if (-not $pids -or $pids.Count -eq 0) {
    Write-Host "[e2e:clean] Port ${port}: free"
    continue
  }

  foreach ($processId in $pids) {
    try {
      $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
      $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
      Write-Host "[e2e:clean] Port ${port}: stopping PID ${processId} ($name)"
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
      Write-Warning "[e2e:clean] Port ${port}: failed to stop PID ${processId}: $($_.Exception.Message)"
      throw
    }
  }
}

Write-Host "[e2e:clean] Done"
