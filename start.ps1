$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontend = Join-Path $root "frontend"
$backend = Join-Path $root "backend"
$gateway = Join-Path $root "gateway"

# Load repo `.env` (if present) for local dev.
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  foreach ($rawLine in (Get-Content $envFile)) {
    # PowerShell 5.1-compatible null handling (no `??` operator).
    $line = ("" + $rawLine).Trim()
    if (!$line) { continue }
    if ($line.StartsWith("#")) { continue }
    if ($line.StartsWith("export ")) { $line = $line.Substring(7).TrimStart() }

    $m = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$')
    if (!$m.Success) { continue }

    $name = $m.Groups[1].Value
    $value = $m.Groups[2].Value.Trim()
    if ($value.Length -ge 2) {
      $first = $value.Substring(0, 1)
      $last = $value.Substring($value.Length - 1, 1)
      if (($first -eq "'" -and $last -eq "'") -or ($first -eq '"' -and $last -eq '"')) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    Set-Item -LiteralPath "Env:$name" -Value $value
  }
}

function Test-LocalTcpPortFree {
  param([int]$Port)
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $listener.Stop()
    return $true
  }
  catch {
    return $false
  }
}

function Get-FirstFreeLocalTcpPort {
  param(
    [int]$PreferredPort,
    [int]$MaxAttempts = 20
  )

  $port = $PreferredPort
  for ($i = 0; $i -lt $MaxAttempts; $i++) {
    if (Test-LocalTcpPortFree -Port $port) { return $port }
    $port++
  }

  throw "Could not find a free TCP port starting at $PreferredPort (tried $MaxAttempts ports)."
}

$BackendPort = if ($env:BACKEND_PORT) { [int]$env:BACKEND_PORT } else { 5000 }
$PreferredFrontendPort = if ($env:FRONTEND_PORT) { [int]$env:FRONTEND_PORT } else { 5173 }
$GatewayPort = if ($env:GATEWAY_PORT) { [int]$env:GATEWAY_PORT } else { 3001 }

$FrontendPort = Get-FirstFreeLocalTcpPort -PreferredPort $PreferredFrontendPort
if ($FrontendPort -ne $PreferredFrontendPort) {
  Write-Host "Note: frontend port $PreferredFrontendPort is already in use; using $FrontendPort instead."
}
$env:FRONTEND_PORT = "$FrontendPort"

$frontendUrl = "http://127.0.0.1:$FrontendPort"
$backendUrl = "http://127.0.0.1:$BackendPort"
$gatewayUrl = "http://127.0.0.1:$GatewayPort"

# Wire services together (inherited by child processes).
if ([string]::IsNullOrWhiteSpace($env:GATEWAY_BASE_URL)) { $env:GATEWAY_BASE_URL = $gatewayUrl }
if ([string]::IsNullOrWhiteSpace($env:BACKEND_WEBHOOK_URL)) { $env:BACKEND_WEBHOOK_URL = "$backendUrl/webhook" }

Write-Host "Starting backend (Flask) at $backendUrl ..."
try {
  Push-Location $backend
  $pyExe = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" } else { throw "Python not found (need 'py' or 'python' on PATH)." }
  
  # FIXED: Check for .venv instead of venv
  if (!(Test-Path ".venv")) { 
    Write-Host "Creating .venv virtual environment..." -ForegroundColor Yellow
    & $pyExe -m venv .venv 
  }
  
  # FIXED: Use .venv instead of venv
  .\.venv\Scripts\pip.exe install -r requirements.txt

  $backendStdout = Join-Path $backend "backend.out.log"
  $backendStderr = Join-Path $backend "backend.err.log"
  
  # FIXED: Use .venv instead of venv
  $backendProc = Start-Process -PassThru -WindowStyle Hidden -FilePath "\.venv\Scripts\python.exe" -ArgumentList "app.py" -RedirectStandardOutput $backendStdout -RedirectStandardError $backendStderr
}
finally {
  Pop-Location
}

Write-Host "Starting gateway (whatsapp-web.js) at $gatewayUrl ..."
try {
  Push-Location $gateway
  if (!(Test-Path "node_modules")) { npm.cmd install }
  # Keep this visible so you can scan the QR code on first run.
  $gatewayProc = Start-Process -PassThru -WindowStyle Normal -FilePath "npm.cmd" -ArgumentList @("run","start")
}
finally {
  Pop-Location
}

Write-Host "Starting frontend (Vite) at $frontendUrl ..."
try {
  Push-Location $frontend
  if (!(Test-Path "node_modules")) { npm.cmd install }
  $frontendStdout = Join-Path $frontend "frontend.out.log"
  $frontendStderr = Join-Path $frontend "frontend.err.log"
  $frontendProc = Start-Process -PassThru -WindowStyle Hidden -FilePath "npm.cmd" -ArgumentList @("run","dev","--","--port",$FrontendPort,"--strictPort") -RedirectStandardOutput $frontendStdout -RedirectStandardError $frontendStderr
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "All set."
Write-Host "- Frontend: $frontendUrl"
Write-Host "- Backend:  $backendUrl/api/health"
Write-Host "- Gateway:  $gatewayUrl/status"
Write-Host "- Logs:     $backendStdout, $backendStderr, $frontendStdout, $frontendStderr"
Write-Host ""
Write-Host "Press Enter to stop all..."
[void][System.Console]::ReadLine()

try { taskkill.exe /F /T /PID $frontendProc.Id } catch {}
try { taskkill.exe /F /T /PID $gatewayProc.Id } catch {}
try { taskkill.exe /F /T /PID $backendProc.Id } catch {}