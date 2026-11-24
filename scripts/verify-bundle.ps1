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

Write-Host '==> uxplay.exe -v'
& (Join-Path $bin 'uxplay.exe') -v
if ($LASTEXITCODE -ne 0) { throw "uxplay.exe -v failed with exit code $LASTEXITCODE (missing DLL?)" }

$elements = @('appsrc','queue','h264parse','decodebin','avdec_h264','avdec_aac','avdec_alac',
  'videoconvert','videoscale','videoflip','autovideosink','d3d11videosink','d3d11h264dec',
  'audioconvert','audioresample','volume','level','autoaudiosink','wasapisink',
  'jpegdec','imagefreeze','textoverlay','aacparse','mp4mux','filesink')
$failed = @()
foreach ($e in $elements) {
  & (Join-Path $bin 'gst-inspect-1.0.exe') --exists $e
  if ($LASTEXITCODE -ne 0) { $failed += $e }
}
if ($failed.Count) { throw "Missing GStreamer elements in bundle: $($failed -join ', ')" }
Write-Host "All $($elements.Count) GStreamer elements found. Bundle OK."
