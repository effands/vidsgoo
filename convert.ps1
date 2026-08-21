
Add-Type -AssemblyName System.Drawing
$srcPath = 'C:\Users\RTX\.gemini\antigravity\brain\3e1f2d6b-1ab3-45c9-b9d5-b911c39d030f\camera_clapper_icon_1787238731369.jpg'
$img = [System.Drawing.Image]::FromFile($srcPath)

$sizes = @(16, 48, 128)
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($img, $s, $s)
    $dest = "e:\AUTO KLIK\Vids Goo\extension\icon$s.png"
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
$img.Dispose()
write-host "Done"
