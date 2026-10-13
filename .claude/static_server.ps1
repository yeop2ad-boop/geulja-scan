$root = Split-Path -Parent $PSScriptRoot
$port = 8091
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".json" = "application/json"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $req = $context.Request
  $res = $context.Response
  $path = $req.Url.LocalPath
  if ($path -eq "/") { $path = "/index.html" }
  $filePath = Join-Path $root ($path.TrimStart("/"))
  # CORS + Private Network Access preflight(2026-09-08): 외부 https 페이지(예: pwabuilder.com)에서 localhost 파일을 fetch할 수 있게
  $res.Headers.Add("Access-Control-Allow-Origin", "*")
  $res.Headers.Add("Access-Control-Allow-Private-Network", "true")
  $res.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
  $res.Headers.Add("Access-Control-Allow-Headers", "*")
  if ($req.HttpMethod -eq "OPTIONS") { $res.StatusCode = 204; $res.OutputStream.Close(); continue }
  try {
    if (Test-Path $filePath -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($filePath)
      $contentType = $mime[$ext]
      if (-not $contentType) { $contentType = "application/octet-stream" }
      $res.ContentType = $contentType
      $fs = [System.IO.File]::OpenRead($filePath)
      $fs.CopyTo($res.OutputStream)
      $fs.Close()
    } else {
      $res.StatusCode = 404
    }
  } catch {
  } finally {
    $res.OutputStream.Close()
  }
}
