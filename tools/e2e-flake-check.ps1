param(
  [int]$Runs = 3,
  [ValidateSet('default','full')]
  [string]$Config = 'full'
)

$ErrorActionPreference = 'Stop'

if ($Runs -lt 1) {
  throw "Runs must be >= 1"
}

$cmd = if ($Config -eq 'full') { @('run', 'e2e:full:clean-run') } else { @('run', 'e2e:clean-run') }

Write-Host "E2E flake check: $Runs run(s) using '$Config' config"
Write-Host ("Command: npm {0}" -f ($cmd -join ' '))

for ($i = 1; $i -le $Runs; $i++) {
  Write-Host "\n--- Run $i / $Runs ---"
  & npm @cmd
  if ($LASTEXITCODE -ne 0) {
    throw "Flake check failed on run $i (exit code $LASTEXITCODE)"
  }
}

Write-Host "\nFlake check passed ($Runs/$Runs)."
