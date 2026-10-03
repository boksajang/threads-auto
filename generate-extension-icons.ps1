param(
  [string]$SourceImage = (Join-Path $PSScriptRoot 'chrome-extension\assets\icon-source-v2.png'),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'chrome-extension\icons')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath([float]$Width, [float]$Height, [float]$Radius) {
  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
  $path.AddArc($Width - $diameter, 0, $diameter, $diameter, 270, 90)
  $path.AddArc($Width - $diameter, $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc(0, $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$sourcePath = [System.IO.Path]::GetFullPath($SourceImage)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not [System.IO.File]::Exists($sourcePath)) {
  throw "아이콘 원본을 찾을 수 없습니다: $sourcePath"
}
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

$source = [System.Drawing.Bitmap]::FromFile($sourcePath)
try {
  # 생성 이미지의 미리보기 체크무늬는 바깥 2%에만 있으므로 타일 경계까지 잘라낸다.
  $cropInset = [Math]::Max(1, [int][Math]::Round($source.Width * 0.02))
  $sourceRect = [System.Drawing.Rectangle]::new(
    $cropInset,
    $cropInset,
    $source.Width - ($cropInset * 2),
    $source.Height - ($cropInset * 2)
  )

  foreach ($size in 16, 32, 48, 128) {
    # 작은 아이콘의 둥근 모서리까지 선명하도록 4배 크기로 마스킹한 뒤 축소한다.
    $workingSize = $size * 4
    $working = [System.Drawing.Bitmap]::new(
      $workingSize,
      $workingSize,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $workingGraphics = [System.Drawing.Graphics]::FromImage($working)
    try {
      $workingGraphics.Clear([System.Drawing.Color]::Transparent)
      $workingGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $workingGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $workingGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $workingGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $radius = [single]($workingSize * 0.145)
      $clipPath = New-RoundedRectanglePath $workingSize $workingSize $radius
      try {
        $workingGraphics.SetClip($clipPath)
        $destination = [System.Drawing.Rectangle]::new(0, 0, $workingSize, $workingSize)
        $workingGraphics.DrawImage($source, $destination, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally {
        $clipPath.Dispose()
      }
    } finally {
      $workingGraphics.Dispose()
    }

    $final = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $finalGraphics = [System.Drawing.Graphics]::FromImage($final)
    try {
      $finalGraphics.Clear([System.Drawing.Color]::Transparent)
      $finalGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $finalGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $finalGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $finalGraphics.DrawImage($working, 0, 0, $size, $size)
      $target = Join-Path $resolvedOutput "icon-$size.png"
      $final.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $finalGraphics.Dispose()
      $final.Dispose()
      $working.Dispose()
    }
  }
} finally {
  $source.Dispose()
}

Write-Output $resolvedOutput
