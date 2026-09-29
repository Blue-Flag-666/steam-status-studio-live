$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$compiler = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'The .NET Framework 4.x C# compiler was not found.' }

$source = Join-Path $root 'src\SteamStatusRunner.cs'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$output = Join-Path $dist 'SteamStatusRunner.exe'
& $compiler /nologo /target:winexe /platform:anycpu "/out:$output" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
