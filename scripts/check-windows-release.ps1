$ErrorActionPreference = 'Stop'
foreach ($file in @('scripts/windows-verify-signatures.ps1', 'scripts/windows-security-scan.ps1')) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $file), [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) { throw ($errors | Out-String) }
}

# A public release must fail even if the expected package/file names exist.
# These harmless text fixtures are never executed or distributed.
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
try {
  $app = Join-Path $fixture 'app'
  $native = Join-Path $app 'resources/app.asar.unpacked/desktop/bin/windows'
  New-Item -ItemType Directory -Force $native | Out-Null
  'Unsigned verification fixture' | Set-Content (Join-Path $app 'Callside.exe')
  'Unsigned verification fixture' | Set-Content (Join-Path $native 'whisper-server.exe')
  'Unsigned verification fixture' | Set-Content (Join-Path $fixture 'Callside-0.0.0-windows-x64.exe')
  'Unsigned verification fixture' | Set-Content (Join-Path $fixture 'Callside-0.0.0-windows-x64.__uninstaller.exe')
  Compress-Archive -Path (Join-Path $app '*') -DestinationPath (Join-Path $fixture 'Callside-0.0.0-windows-x64.zip')
  $PSNativeCommandUseErrorActionPreference = $false
  & pwsh -NoProfile -File scripts/windows-verify-signatures.ps1 -PackageDirectory $fixture -Version 0.0.0 -Publisher 'Callside unsigned fixture' 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -eq 0) { throw 'Unsigned release fixture was incorrectly accepted.' }
  $report = Get-Content (Join-Path $fixture 'SIGNATURES.json') -Raw | ConvertFrom-Json
  if ($report.passed -or $report.files.Count -ne 1 -or $report.files[0].status -eq 'Valid') {
    throw 'Signature check did not reject the unsigned file for the expected reason.'
  }
  Write-Host 'Windows release scripts parse; unsigned public distribution is rejected.'
} finally {
  if (Test-Path $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
# The child must fail; do not let the Actions PowerShell wrapper interpret that
# expected native exit code as failure of the test harness itself.
exit 0
