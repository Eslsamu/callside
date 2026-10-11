param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [string]$ReportDirectory = '.local/windows-security',
  [switch]$ExtractPortable
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
New-Item -ItemType Directory -Force $ReportDirectory | Out-Null
$reportPath = Join-Path (Resolve-Path $ReportDirectory) 'defender-report.json'
$report = [ordered]@{
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  passed = $false
  scope = 'Microsoft Defender static scan; does not establish browser reputation or guarantee safety.'
  files = @()
  scans = @()
}
try {
  $root = (Resolve-Path $PackageDirectory).Path
  $service = Get-Service WinDefend
  if ($service.StartType -eq 'Disabled') { Set-Service WinDefend -StartupType Automatic }
  if ($service.Status -ne 'Running') { Start-Service WinDefend }
  Update-MpSignature -UpdateSource MMPC
  $status = Get-MpComputerStatus
  $report.engine = $status | Select-Object AMEngineVersion, AMProductVersion, AntivirusSignatureVersion, AntivirusSignatureLastUpdated, AMServiceEnabled, AntivirusEnabled
  if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled) {
    throw 'Microsoft Defender is not available for a verified scan.'
  }
  if ($status.AntivirusSignatureLastUpdated -lt (Get-Date).AddDays(-2)) {
    throw 'Defender signatures are older than two days.'
  }
  $scanner = Get-ChildItem "$env:ProgramData\Microsoft\Windows Defender\Platform\*\MpCmdRun.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $scanner) { $scanner = "$env:ProgramFiles\Windows Defender\MpCmdRun.exe" }
  if (-not (Test-Path $scanner)) { throw 'Defender scanner executable is unavailable.' }
  foreach ($name in @('Callside-Windows-Test-x64.exe', 'Callside-Windows-Test-x64.zip')) {
    $file = Join-Path $root $name
    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    $report.files += @{ name = $name; sha256 = $hash; bytes = (Get-Item $file).Length }
    $sumFile = Join-Path $root 'SHA256SUMS.txt'
    if (Test-Path $sumFile) {
      $expected = @(Get-Content $sumFile | Where-Object { $_.Trim().EndsWith("  $name") })
      if ($expected.Count -ne 1 -or $expected[0].Split(' ')[0].ToLower() -ne $hash) {
        throw "Checksum verification failed for $name"
      }
    }
  }
  if (Test-Path (Join-Path $root 'BUILD.json')) {
    $report.build = Get-Content (Join-Path $root 'BUILD.json') -Raw | ConvertFrom-Json
  }
  if ($ExtractPortable) {
    Expand-Archive (Join-Path $root 'Callside-Windows-Test-x64.zip') (Join-Path $root 'expanded')
  }
  # Custom diagnostic scans ignore exclusions, scan archives, and retain detections
  # in command output without removing evidence. Real-time protection stays enabled.
  $output = & $scanner -Scan -ScanType 3 -File $root -DisableRemediation 2>&1
  $scanExit = $LASTEXITCODE
  $output | Set-Content (Join-Path $ReportDirectory 'defender-scan.txt')
  $output | Write-Output
  $report.scans += @{ exitCode = $scanExit; target = 'installer, portable archive and unpacked files' }
  $report.detections = @(Get-MpThreatDetection | Select-Object ThreatID, InitialDetectionTime, Resources, ActionSuccess)
  if ($scanExit -ne 0 -or $report.detections.Count -gt 0) {
    throw 'Defender reported a detection or scan error. Inspect the retained scan output.'
  }
  $report.passed = $true
} catch {
  $report.error = $_.Exception.Message
  Write-Warning $report.error
} finally {
  $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $report | ConvertTo-Json -Depth 10 | Set-Content $reportPath
}
if (-not $report.passed) { exit 1 }
