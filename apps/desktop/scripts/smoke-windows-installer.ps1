$ErrorActionPreference = "Stop"

$version = (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
$installer = Get-Item "release/OpenRoughCut-$version-win-x64.exe"
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
if ($signature.Status -ne "NotSigned") {
  throw "Expected an unsigned signing candidate, got Authenticode status $($signature.Status)."
}
Write-Output "Candidate $($installer.Name), $($installer.Length) bytes, Authenticode $($signature.Status)."

$smoke = Join-Path $env:RUNNER_TEMP "orc-windows-smoke"
$install = Join-Path $smoke "app"
$profile = Join-Path $smoke "profile"
New-Item -ItemType Directory -Path $smoke | Out-Null

# NSIS requires /D to be last and unquoted, including when the path contains spaces.
$setup = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$install" -PassThru
if (-not $setup.WaitForExit(90000)) {
  Stop-Process -Id $setup.Id -Force
  throw "Windows installer did not exit within 90 seconds."
}
if ($setup.ExitCode -ne 0) { throw "Windows installer returned $($setup.ExitCode)." }

$app = Get-Item (Join-Path $install "OpenRoughCut.exe")
$reader = [IO.BinaryReader]::new([IO.File]::OpenRead($app.FullName))
try {
  $reader.BaseStream.Position = 0x3c
  $reader.BaseStream.Position = $reader.ReadInt32()
  if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
    throw "The installed application is not a Windows x64 executable."
  }
} finally {
  $reader.Dispose()
}

$resources = Join-Path $install "resources"
$required = @(
  "app.asar",
  "THIRD-PARTY-NOTICES.txt",
  "licenses/OpenRoughCut-LICENSE.txt",
  "licenses/Electron-LICENSE.txt",
  "licenses/LICENSES.chromium.html",
  "runtime/licenses/whisper.cpp-mit.txt"
)
foreach ($name in $required) {
  if ((Get-Item (Join-Path $resources $name)).Length -eq 0) { throw "Empty installed file: $name." }
}
if ((Get-FileHash LICENSE).Hash -ne (Get-FileHash (Join-Path $resources "licenses/OpenRoughCut-LICENSE.txt")).Hash) {
  throw "The packaged MIT license differs from the source."
}
$runtimeManifest = Get-Content vendor/win32-x64/runtime-manifest.json -Raw | ConvertFrom-Json
$whisper = $runtimeManifest.components | Where-Object { $_.name -eq "whisper.cpp" }
foreach ($file in $whisper.files.PSObject.Properties) {
  $installedFile = Join-Path (Join-Path $resources "runtime") $file.Name
  if ((Get-FileHash $installedFile).Hash -ne $file.Value) { throw "Runtime checksum mismatch: $($file.Name)." }
}
foreach ($binary in "ffmpeg.exe", "ffprobe.exe") {
  if (Get-ChildItem -Path $resources -Recurse -Filter $binary) { throw "The installer unexpectedly includes $binary." }
}
Write-Output "Installed x64 app, licenses and checksum-pinned Whisper files verified."

$whisperExecutable = Join-Path $resources "runtime/bin/whisper-cli.exe"
$whisperCheck = Start-Process -FilePath $whisperExecutable -ArgumentList "--help" -PassThru -Wait
if ($whisperCheck.ExitCode -ne 0) { throw "The installed Whisper executable returned $($whisperCheck.ExitCode)." }

$process = Start-Process -FilePath $app.FullName -ArgumentList ('--user-data-dir="{0}"' -f $profile) -PassThru
try {
  $log = Join-Path $profile "logs/openroughcut.log"
  $started = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($process.HasExited) { throw "The installed app exited during startup with code $($process.ExitCode)." }
    if (Test-Path $log) {
      $events = Get-Content $log | ForEach-Object { $_ | ConvertFrom-Json }
      $appStarted = $events | Where-Object {
        $_.event -eq "app.started" -and $_.details.packaged -and $_.details.platform -eq "win32" -and
        $_.details.arch -eq "x64" -and $_.details.version -eq $version
      }
      $runtimeChecked = $events | Where-Object { $_.event -eq "runtime.checked" }
      $process.Refresh()
      if ($appStarted -and $runtimeChecked -and $process.MainWindowHandle -ne 0) {
        $started = $true
        break
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $started) { throw "The packaged app did not open its main window and check runtime dependencies." }
  if ($events | Where-Object { $_.level -eq "error" }) { throw "The installed app reported an error during startup." }
  Write-Output "Packaged OpenRoughCut $version opened its main window on Windows x64 and checked runtime dependencies."
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}

$uninstaller = Get-ChildItem -Path $install -Filter "Uninstall *.exe" -File
if (@($uninstaller).Count -ne 1) { throw "Expected exactly one installed uninstaller." }
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait
if ($uninstall.ExitCode -ne 0 -or (Test-Path $app.FullName)) { throw "The installed app did not uninstall cleanly." }
Write-Output "Silent uninstall removed the installed app."

$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $($installer.Name)" | Set-Content release/SHA256SUMS-win-x64.txt -Encoding ascii
Write-Output "SHA-256 $hash"
