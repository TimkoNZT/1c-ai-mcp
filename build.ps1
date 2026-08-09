param([switch]$Force)

$src = @(
  "config.js", "logger.js", "session.js", "tools.js",
  "sse-reader.js", "chat-client.js", "mcp-handler.js", "index.js"
)
$proxyDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $proxyDir "src"
$distDir = Join-Path $proxyDir "dist"
$null = New-Item -ItemType Directory -Path $distDir -Force
$outPath = Join-Path $distDir "1c-ai-mcp.js"

$builtinLines = @()   # deduplicated Node.js builtin imports
$seenMod = @{}        # module name -> true
$bodyParts = @()

foreach ($f in $src) {
  $c = Get-Content (Join-Path $srcDir $f) -Raw -Encoding UTF8

  # --- Extract builtin imports (before stripping) ---
  $imports = [regex]::Matches($c, '(?m)^import\s+[\s\S]*?from\s+"([^"]+)"\s*;')
  foreach ($m in $imports) {
    $full = $m.Value.Trim()
    $mod = $m.Groups[1].Value
    if ($mod.StartsWith(".")) { continue }  # skip local
    if (-not $seenMod.ContainsKey($mod)) {
      $seenMod[$mod] = $true
      $builtinLines += $full
    }
  }

  # --- Strip shebang line ---
  $c = $c -replace '(?m)^#!.*\n?', ''

  # --- Strip ALL import statements from body ---
  $c = [regex]::Replace($c, '(?m)^import\s+[\s\S]*?from\s+"[^"]+"\s*;\n?', '')

  # Strip export { ... } blocks
  $c = [regex]::Replace($c, '(?m)^export\s+\{[^}]*\}\s*;\n?', '')

  # Strip export prefix
  $c = $c -replace '(?m)^export\s+(function|class|const|async|let|var|default)\s', '$1 '

  $bodyParts += $c.TrimStart()
}

$output = @(
  '#!/usr/bin/env node'
  '// Zero-dependency bundle — MCP only'
  "// Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  ''
  ($builtinLines -join "`n")
  ''
  ($bodyParts -join "`n`n")
) -join "`n"

[System.IO.File]::WriteAllText($outPath, $output)
$size = (Get-Item $outPath).Length
Write-Host "✅ $([System.IO.Path]::GetFileName($outPath)) ($([math]::Round($size/1KB)) KB)" -ForegroundColor Green
