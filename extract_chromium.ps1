$zipPath = "C:\Users\rahul\AppData\Local\Temp\playwright-download-cRDl7s\playwright-download-chromium-win64-1217.zip"
$destPath = "C:\Users\rahul\AppData\Local\ms-playwright\chromium-1217"

Write-Host "Extracting Chromium from: $zipPath"
Write-Host "Destination: $destPath"

Expand-Archive -Path $zipPath -DestinationPath $destPath -Force

Write-Host "Done! Checking for chrome.exe..."
$chromeExe = Join-Path $destPath "chrome-win64\chrome.exe"
if (Test-Path $chromeExe) {
    Write-Host "SUCCESS: chrome.exe found at $chromeExe"
} else {
    Write-Host "WARNING: chrome.exe not found, checking folder contents..."
    Get-ChildItem $destPath -Recurse -Name | Select-Object -First 20
}
