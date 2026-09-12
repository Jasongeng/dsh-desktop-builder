#requires -Version 7.0
<#
.SYNOPSIS
    Write a flat-color 256x256 icon.ico so a branded build can run before final artwork exists.

.DESCRIPTION
    Draws centered text on a solid background and wraps the PNG in a single-entry ICO container.
    electron-builder accepts PNG-compressed entries and requires at least one 256x256 image.

.PARAMETER Path
    Destination file. Defaults to icon.ico beside this script.

.PARAMETER Text
    Text drawn in the middle of the icon. Keep it to three or four characters.
#>
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $PSScriptRoot 'icon.ico'),
    [string]$Text = 'DSH'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$png = $null
try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::FromArgb(255, 77, 107, 254))
    $font = [System.Drawing.Font]::new('Segoe UI', 96, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    try {
        $format = [System.Drawing.StringFormat]::new()
        try {
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            $graphics.DrawString($Text, $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, 0, $size, $size), $format)
        }
        finally { $format.Dispose() }
    }
    finally { $font.Dispose() }

    $stream = [System.IO.MemoryStream]::new()
    try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $png = $stream.ToArray()
    }
    finally { $stream.Dispose() }
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

# ICONDIR (6 bytes) followed by one ICONDIRENTRY (16 bytes).
$header = [byte[]]::new(22)
$header[2] = 1                  # idType: 1 = icon
$header[4] = 1                  # idCount
$header[6] = 0                  # width: 0 encodes 256
$header[7] = 0                  # height: 0 encodes 256
$header[10] = 1                 # wPlanes
$header[12] = 32                # wBitCount
[BitConverter]::GetBytes([int]$png.Length).CopyTo($header, 14)
[BitConverter]::GetBytes([int]22).CopyTo($header, 18)

$buffer = [byte[]]::new($header.Length + $png.Length)
$header.CopyTo($buffer, 0)
$png.CopyTo($buffer, $header.Length)
[System.IO.File]::WriteAllBytes($Path, $buffer)
Write-Host "wrote $Path ($($buffer.Length) bytes)"
