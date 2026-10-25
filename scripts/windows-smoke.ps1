# Aurum Windows smoke test. Run in PowerShell from the repo folder:  powershell -ExecutionPolicy Bypass -File scripts\windows-smoke.ps1
# It changes nothing. It checks what Aurum needs and prints PASS / FAIL / WARN with the fix.
$ErrorActionPreference = 'Continue'
$fails = 0
function Show($state, $name, $detail) {
  $c = @{ PASS = 'Green'; FAIL = 'Red'; WARN = 'Yellow' }[$state]
  Write-Host ("[{0}] {1}" -f $state, $name) -ForegroundColor $c
  if ($detail) { Write-Host ("       " + $detail) }
  if ($state -eq 'FAIL') { $script:fails++ }
}

# Node
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $v = (node -v); if ([int]($v.TrimStart('v').Split('.')[0]) -ge 20) { Show PASS 'Node.js' $v } else { Show FAIL 'Node.js' "$v is too old. Install Node 20 or newer." } } else { Show FAIL 'Node.js' 'Not found. Install Node 20+ from nodejs.org.' }

# Python the same way the app picks it (AURUM_PYTHON, else python)
$py = if ($env:AURUM_PYTHON) { $env:AURUM_PYTHON } else { 'python' }
$pyCmd = Get-Command $py -ErrorAction SilentlyContinue
if (-not $pyCmd) { Show FAIL 'Python' "'$py' not found. Install 64-bit Python 3.12 and tick 'Add to PATH', or set AURUM_PYTHON to python.exe." }
else {
  $info = & $py -c "import sys,platform,struct;print(sys.executable+'|'+platform.python_version()+'|'+str(struct.calcsize('P')*8))"
  $parts = $info.Split('|')
  Show PASS 'Python' ("{0} ({1}, {2}-bit) at {3}" -f $parts[1], 'in use by Aurum', $parts[2], $parts[0])
  if ($parts[2] -ne '64') { Show FAIL 'Python is 64-bit' 'MetaTrader5 needs 64-bit Python.' }
  $mt = & $py -c "import MetaTrader5 as m;print(m.__version__)" 2>&1
  if ($LASTEXITCODE -eq 0) { Show PASS 'MetaTrader5 package' $mt } else { Show FAIL 'MetaTrader5 package' ("Install it for exactly this Python:  `"{0}`" -m pip install MetaTrader5   (if pip finds nothing, use Python 3.12 64-bit)" -f $parts[0]) }
}

# MT5 terminals
$roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
$terms = foreach ($r in $roots) { Get-ChildItem -Path $r -Filter 'terminal64.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'MetaTrader' } }
if ($terms) { Show PASS 'MT5 terminal found' (($terms | ForEach-Object FullName) -join "`n       ") } else { Show WARN 'MT5 terminal' 'No terminal64.exe found in Program Files. If MT5 is installed elsewhere, set its path in Aurum Settings > General.' }
$proc = Get-Process terminal64 -ErrorAction SilentlyContinue
if ($proc) { Show PASS 'MT5 is running' ("{0} process(es)" -f @($proc).Count) } else { Show WARN 'MT5 is running' 'Open MT5 and log in to your DEMO account before starting Aurum.' }
if ($proc) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($admin) { Show WARN 'Privilege level' 'This shell is Administrator. Run MT5 and Aurum at the same level (normal user for both) or the connection fails with Authorization failed.' } else { Show PASS 'Privilege level' 'Normal user (MT5 must also be a normal user).' }
}

# Ports used by Aurum (EA hub 8766)
foreach ($p in 8766) { $used = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($used) { Show WARN "Port $p" 'Already in use (another Aurum or program). The EA bridge hub needs it free.' } else { Show PASS "Port $p free" '' } }

# Repo checks
if (Test-Path 'package.json') {
  if (-not (Test-Path 'node_modules')) { Show WARN 'npm install' 'node_modules missing. Run: npm install' } else { Show PASS 'node_modules present' '' }
  if ($node) { npm test 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Host "       $_" }; if ($LASTEXITCODE -eq 0) { Show PASS 'npm test' '' } else { Show FAIL 'npm test' 'See the output above.' } }
} else { Show WARN 'Repo folder' 'Run this from the Aurum folder (where package.json is).' }

Write-Host ''
if ($fails -eq 0) { Write-Host 'No blocking problems found. Start the app with:  npm run dev' -ForegroundColor Green } else { Write-Host "$fails blocking problem(s). Fix the FAIL lines above and run this again." -ForegroundColor Red }
