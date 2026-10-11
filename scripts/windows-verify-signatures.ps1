param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Publisher
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $PackageDirectory).Path
$report = [ordered]@{ passed = $false; publisher = $Publisher; files = @() }
try {
  # Check the shipped archive itself, not just the pre-package source directory.
  $zip = Join-Path $root "Callside-$Version-windows-x64.zip"
  $expanded = Join-Path $root 'signature-check'
  if (Test-Path $expanded) { throw 'Signature-check output already exists; use a fresh directory.' }
  Expand-Archive -LiteralPath $zip -DestinationPath $expanded
  $required = @(
    (Join-Path $root "Callside-$Version-windows-x64.exe"),
    (Join-Path $expanded 'Callside.exe'),
    (Join-Path $expanded 'resources/app.asar.unpacked/desktop/bin/windows/whisper-server.exe')
  )
  # electron-builder also leaves its signed NSIS uninstaller beside the package.
  $uninstallers = @(Get-ChildItem $root -Filter '*uninstaller*.exe' -File)
  if ($uninstallers.Count -ne 1) { throw 'Expected the signed NSIS uninstaller for verification.' }
  $required += $uninstallers[0].FullName
  $required += @(Get-ChildItem $expanded -Recurse -File -Filter '*.dll' | Select-Object -ExpandProperty FullName)
  foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing signed file: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    $subject = if ($signature.SignerCertificate) {
      $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    } else { '' }
    $entry = [ordered]@{
      file = [System.IO.Path]::GetRelativePath($root, $file)
      status = [string]$signature.Status
      publisher = $subject
      thumbprint = $signature.SignerCertificate.Thumbprint
      timestamped = $null -ne $signature.TimeStamperCertificate
      sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
    }
    $report.files += $entry
    if ($signature.Status -ne 'Valid' -or $subject -cne $Publisher -or -not $entry.timestamped) {
      throw "Invalid, unexpected-publisher or untimestamped signature: $file"
    }
  }
  $report.passed = $true
} finally {
  $report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $root 'SIGNATURES.json')
}
if (-not $report.passed) { exit 1 }
