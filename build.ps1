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

$builtinLines = @()   # merged Node.js builtin imports (all named from each module)
$importNames = @{}    # module name -> set of named imports
$importNs = @{}       # module name -> namespace alias (first wins)
$bodyParts = @()

foreach ($f in $src) {
  $c = Get-Content (Join-Path $srcDir $f) -Raw -Encoding UTF8

  # --- Extract builtin imports (before stripping) ---
  # Forms handled: import { a, b } from "mod";  import * as ns from "mod";
  $imports = [regex]::Matches($c, '(?m)^import\s+(.+?)\s+from\s+"([^"]+)"\s*;')
  foreach ($m in $imports) {
    $clause = $m.Groups[1].Value.Trim()
    $mod = $m.Groups[2].Value
    if ($mod.StartsWith(".")) { continue }  # skip local
    if ($clause -match '^\{\s*(.+?)\s*\}$') {
      if (-not $importNames.ContainsKey($mod)) { $importNames[$mod] = @{} }
      foreach ($n in ($clause -replace '^\{\s*', '' -replace '\s*\}$', '' -split ',')) {
        $nm = $n.Trim()
        if ($nm) { $importNames[$mod][$nm] = $true }
      }
    } elseif ($clause -match '^\*\s+as\s+([A-Za-z_$][\w$]*)$') {
      if (-not $importNs.ContainsKey($mod)) { $importNs[$mod] = $Matches[1] }
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

# --- Compose merged import lines per module (across all files) ---
foreach ($mod in @($importNames.Keys | Sort-Object)) {
  $names = @($importNames[$mod].Keys | Sort-Object)
  if ($names.Count -gt 0) {
    $builtinLines += "import { $($names -join ', ') } from `"$mod`";"
  }
}
foreach ($mod in @($importNs.Keys | Sort-Object)) {
  $builtinLines += "import * as $($importNs[$mod]) from `"$mod`";"
}
$builtinLines = @($builtinLines | Sort-Object -Unique)

$repoUrl = "https://github.com/TimkoNZT/1c-ai-mcp"
$author  = "TimkoNZT"
$output = @(
  '#!/usr/bin/env node'
  '// Zero-dependency bundle — MCP only'
  "// Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  "//"
  "// Source: $repoUrl"
  "// Author: $author"
  "// License: MIT"
  ''
  ($builtinLines -join "`n")
  ''
  ($bodyParts -join "`n`n")
) -join "`n"

[System.IO.File]::WriteAllText($outPath, $output)
$size = (Get-Item $outPath).Length
Write-Host "✅ $([System.IO.Path]::GetFileName($outPath)) ($([math]::Round($size/1KB)) KB)" -ForegroundColor Green
