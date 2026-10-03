param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'ThreadsAuto.NativeHost.cs'
$outputDirectory = Join-Path $PSScriptRoot 'bin'
$output = if ($OutputPath) { $OutputPath } else { Join-Path $outputDirectory 'ThreadsAuto.NativeHost.exe' }
$compiler = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
& $compiler /nologo /target:exe /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "Native Host 컴파일 실패: $LASTEXITCODE" }
Write-Output $output
