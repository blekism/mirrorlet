# Checks that vendor/uxplay runs on its own, with none of MSYS2 on PATH.
# This is what catches a missing DLL or plugin before it reaches an installer.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\vendor\uxplay')
$bin = Join-Path $root 'bin'
$plugins = Join-Path $root 'lib\gstreamer-1.0'

$env:PATH = "$bin;$env:SystemRoot\System32;$env:SystemRoot"
$env:GST_PLUGIN_SYSTEM_PATH_1_0 = $plugins
$env:GST_PLUGIN_PATH_1_0 = ''
$env:GST_PLUGIN_SCANNER_1_0 = Join-Path $root 'libexec\gstreamer-1.0\gst-plugin-scanner.exe'
$env:GST_REGISTRY_1_0 = Join-Path ([IO.Path]::GetTempPath()) 'gst-verify-registry.bin'

$uxplay = Join-Path $bin 'uxplay.exe'

# uxplay.exe must be GUI-subsystem (-mwindows): Mirrorlet then spawns it without
# windowsHide, which is what keeps GStreamer's video window from starting hidden.
$bytes = [IO.File]::ReadAllBytes($uxplay)
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
$subsystem = [BitConverter]::ToUInt16($bytes, $pe + 4 + 20 + 68)
if ($subsystem -ne 2) { throw "uxplay.exe subsystem is $subsystem, expected 2 (GUI). Rebuild with scripts/build-uxplay.sh." }
Write-Host '==> uxplay.exe is a GUI-subsystem executable'

# PowerShell doesn't wait for GUI-subsystem programs started with '&', so use Start-Process.
# Redirecting stdout also proves output still reaches a parent through a pipe.
Write-Host '==> uxplay.exe -v'
$outFile = Join-Path ([IO.Path]::GetTempPath()) 'uxplay-verify-out.txt'
$errFile = Join-Path ([IO.Path]::GetTempPath()) 'uxplay-verify-err.txt'
$p = Start-Process -FilePath $uxplay -ArgumentList '-v' -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$out = (Get-Content $outFile -Raw) + (Get-Content $errFile -Raw)
Write-Host $out
if ($p.ExitCode -ne 0) { throw "uxplay.exe -v failed with exit code $($p.ExitCode) (missing DLL?)" }
if ($out -notmatch 'UxPlay') { throw 'uxplay.exe -v printed nothing to stdout/stderr: output is not reaching the pipe' }

$inspect = Join-Path $bin 'gst-inspect-1.0.exe'

# Elements that must load on ANY machine (software paths, no GPU needed).
$elements = @('appsrc','queue','h264parse','decodebin','avdec_h264','avdec_aac','avdec_alac',
  'videoconvert','videoscale','videoflip','autovideosink','d3d11videosink',
  'audioconvert','audioresample','volume','level','autoaudiosink','wasapisink',
  'jpegdec','imagefreeze','textoverlay','aacparse','mp4mux','filesink')
$failed = @()
foreach ($e in $elements) {
  & $inspect --exists $e
  if ($LASTEXITCODE -ne 0) { $failed += $e }
}
if ($failed.Count) { throw "Missing GStreamer elements in bundle: $($failed -join ', ')" }
Write-Host "All $($elements.Count) required GStreamer elements found."

# GPU (DXVA) decoders only register when Windows finds a GPU that can decode video.
# CI runners have none, so these are informational: on a real PC decodebin picks them
# automatically, and falls back to avdec_h264 (software) if they're absent.
$pluginFile = Join-Path $plugins 'libgstd3d11.dll'
if (-not (Test-Path $pluginFile)) { throw "libgstd3d11.dll is missing from the bundle" }
foreach ($e in @('d3d11h264dec','d3d11h265dec','d3d12h264dec')) {
  & $inspect --exists $e
  $state = if ($LASTEXITCODE -eq 0) { 'available' } else { 'not registered here (no video-capable GPU on this machine)' }
  Write-Host "   hardware decoder ${e}: $state"
}
Write-Host 'Bundle OK.'
# GitHub's pwsh wrapper exits with $LASTEXITCODE of the last native command, which is
# the (expected) "not found" from the optional decoder probe above. Exit 0 explicitly.
exit 0
