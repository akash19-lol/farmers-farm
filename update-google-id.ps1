# =====================================================
# Farmers Farm - Google Client ID Update Script
# =====================================================
# Usage: .\update-google-id.ps1 -ClientId "YOUR_ACTUAL_CLIENT_ID"
# Example: .\update-google-id.ps1 -ClientId "123456789-abc.apps.googleusercontent.com"

param(
    [Parameter(Mandatory=$true)]
    [string]$ClientId
)

$envFile = "d:\farners farm\backend\.env"
$envContent = Get-Content $envFile -Raw -Encoding UTF8
if ($envContent -match 'GOOGLE_CLIENT_ID=') {
    $envUpdated = $envContent -replace 'GOOGLE_CLIENT_ID=.*', "GOOGLE_CLIENT_ID=$ClientId"
} else {
    $envUpdated = $envContent.TrimEnd() + "`r`nGOOGLE_CLIENT_ID=$ClientId`r`n"
}
Set-Content -Path $envFile -Value $envUpdated -Encoding UTF8 -NoNewline

Write-Host "SUCCESS! Google Client ID updated in backend/.env." -ForegroundColor Green
Write-Host "All frontend pages now load it dynamically from /api/auth/config." -ForegroundColor Cyan
Write-Host "Client ID: $ClientId" -ForegroundColor Yellow
