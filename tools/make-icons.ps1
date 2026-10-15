# Regenerates the toolbar icons in src/ui/resources from the Sciagen logo (sciagen.ai favicon)
# run: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot "..\src\ui\resources"
$logo = New-Object System.Drawing.Bitmap (Join-Path $PSScriptRoot "sciagen-logo.png")
$navy = [System.Drawing.Color]::FromArgb(3, 4, 96)
$cyan = [System.Drawing.Color]::FromArgb(2, 180, 216)

function Draw-Icon([int]$size, [string]$file, [int]$progress = -1) {
	$bmp = New-Object System.Drawing.Bitmap $size, $size
	$g = [System.Drawing.Graphics]::FromImage($bmp)
	$g.SmoothingMode = "AntiAlias"
	$g.InterpolationMode = "HighQualityBicubic"
	$g.PixelOffsetMode = "HighQuality"
	$s = $size / 128.0
	# logo keeps its aspect ratio, centered; leaves room for the progress bar when waiting
	$boxHeight = if ($progress -ge 0) { 100 * $s } else { $size }
	$scale = [Math]::Min($size / $logo.Width, $boxHeight / $logo.Height)
	$w = $logo.Width * $scale; $h = $logo.Height * $scale
	$g.DrawImage($logo, [single](($size - $w) / 2), [single](($boxHeight - $h) / 2), [single]$w, [single]$h)
	if ($progress -ge 0) {
		# progress bar along the bottom, 9 steps (0..8)
		$bx = 8 * $s; $by = 110 * $s; $bw = 112 * $s; $bh = 14 * $s
		$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, $navy))), $bx, $by, $bw, $bh)
		$g.FillRectangle((New-Object System.Drawing.SolidBrush $cyan), $bx, $by, [single]($bw * ($progress + 1) / 9), $bh)
	}
	$bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
	$g.Dispose(); $bmp.Dispose()
}

foreach ($size in 16, 32, 48, 64, 128) { Draw-Icon $size "icon_$size.png" }
foreach ($i in 0..8) { Draw-Icon 128 "icon_128_wait$i.png" $i }
$logo.Dispose()
