Add-Type -AssemblyName System.Drawing

# Create .ico file from PNG
$pngPath = "e:\AUTO KLIK\Vids Goo\icon256.png"
$icoPath = "e:\AUTO KLIK\Vids Goo\vidsgoo.ico"
$favIcoPath = "e:\AUTO KLIK\Vids Goo\public\favicon.ico"

$bmp = [System.Drawing.Bitmap]::FromFile($pngPath)
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)

$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close()

Copy-Item $icoPath $favIcoPath -Force

$icon.Dispose()
$bmp.Dispose()

# Create and update Desktop shortcuts with new icon
$WshShell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$targetBat = "e:\AUTO KLIK\Vids Goo\start_server.bat"

# VIDS GOO Studio shortcut
$shortcut = $WshShell.CreateShortcut("$desktop\VIDS GOO Studio.lnk")
$shortcut.TargetPath = $targetBat
$shortcut.WorkingDirectory = "e:\AUTO KLIK\Vids Goo"
$shortcut.IconLocation = "$icoPath,0"
$shortcut.Description = "VIDS GOO - Multi-Chrome Studio"
$shortcut.Save()

# Update Google Vids Server shortcut if present
if (Test-Path "$desktop\Google Vids Server.lnk") {
    $old = $WshShell.CreateShortcut("$desktop\Google Vids Server.lnk")
    $old.TargetPath = $targetBat
    $old.WorkingDirectory = "e:\AUTO KLIK\Vids Goo"
    $old.IconLocation = "$icoPath,0"
    $old.Description = "VIDS GOO - Multi-Chrome Studio"
    $old.Save()
}

Write-Host "Desktop shortcut and icons updated successfully!"
