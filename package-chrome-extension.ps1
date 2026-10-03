param(
  [string]$SourceDirectory = (Join-Path $PSScriptRoot 'chrome-extension'),
  [string]$OutputFile = (Join-Path $PSScriptRoot 'artifacts\chrome-extension\threads-auto-shopping-collector-0.1.13.zip')
)

$ErrorActionPreference = 'Stop'

$sourceRoot = [System.IO.Path]::GetFullPath($SourceDirectory)
$outputPath = [System.IO.Path]::GetFullPath($OutputFile)
$outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)

if (-not $sourceRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw '확장 프로그램 원본 경로는 프로젝트 내부여야 합니다.'
}
if (-not $outputPath.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw '업로드 ZIP 경로는 프로젝트 내부여야 합니다.'
}

$relativeFiles = @(
  'manifest.json',
  'service-worker.js',
  'content-script.js',
  'icons\icon-16.png',
  'icons\icon-32.png',
  'icons\icon-48.png',
  'icons\icon-128.png'
)

foreach ($relativeFile in $relativeFiles) {
  $filePath = Join-Path $sourceRoot $relativeFile
  if (-not [System.IO.File]::Exists($filePath)) {
    throw "필수 파일이 없습니다: $relativeFile"
  }
}

$manifestPath = Join-Path $sourceRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw 'manifest_version은 3이어야 합니다.' }
if (@($manifest.permissions).Count -ne 1 -or $manifest.permissions[0] -ne 'nativeMessaging') {
  throw '확장 프로그램 권한은 nativeMessaging 하나만 허용합니다.'
}
$expectedHostPermissions = @(
  'https://www.coupang.com/vp/products/*',
  'https://brand.naver.com/*',
  'https://smartstore.naver.com/*',
  'https://shopping.naver.com/*',
  'https://pkgtour.naver.com/products/*'
)
$actualHostPermissions = @($manifest.host_permissions)
if ($actualHostPermissions.Count -ne $expectedHostPermissions.Count) {
  throw '허용된 쿠팡·네이버 상품 페이지 외의 호스트 권한이 포함되어 있습니다.'
}
foreach ($permission in $expectedHostPermissions) {
  if ($actualHostPermissions -notcontains $permission) {
    throw "필수 상품 페이지 권한이 없습니다: $permission"
  }
}
if ($manifest.PSObject.Properties.Name -contains 'update_url') {
  throw 'Chrome Web Store가 관리하는 update_url을 원본에 직접 포함할 수 없습니다.'
}
if (-not ($manifest.PSObject.Properties.Name -contains 'key') -or [string]::IsNullOrWhiteSpace([string]$manifest.key)) {
  throw '개발자 모드와 Web Store가 같은 확장 ID를 사용하려면 공식 공개 key가 필요합니다.'
}
try {
  $publicKeyBytes = [Convert]::FromBase64String([string]$manifest.key)
} catch {
  throw 'manifest key가 올바른 Base64 공개 키가 아닙니다.'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $keyHash = $sha256.ComputeHash($publicKeyBytes)
} finally {
  $sha256.Dispose()
}
$extensionIdCharacters = foreach ($value in $keyHash[0..15]) {
  [char](97 + (($value -shr 4) -band 15))
  [char](97 + ($value -band 15))
}
$derivedExtensionId = -join $extensionIdCharacters
$expectedExtensionId = 'haecnhoaegieddnhookppmcmdahidlal'
if ($derivedExtensionId -ne $expectedExtensionId) {
  throw "manifest key에서 계산한 확장 ID가 공식 Item ID와 다릅니다: $derivedExtensionId"
}

[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
if ([System.IO.File]::Exists($outputPath)) {
  [System.IO.File]::Delete($outputPath)
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($outputPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relativeFile in $relativeFiles) {
    $filePath = Join-Path $sourceRoot $relativeFile
    $entryName = $relativeFile.Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $filePath,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$hash = Get-FileHash -LiteralPath $outputPath -Algorithm SHA256
[pscustomobject]@{
  Path = $outputPath
  Bytes = [System.IO.FileInfo]::new($outputPath).Length
  SHA256 = $hash.Hash
}
