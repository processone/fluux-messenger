Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$signingRequired = $env:WINDOWS_CODE_SIGNING_REQUIRED -eq "true"

$releaseDirectory = Join-Path $PSScriptRoot "target/release"
$applicationPath = Join-Path $releaseDirectory "fluux.exe"
$nsisDirectory = Join-Path $releaseDirectory "bundle/nsis"
$msiDirectory = Join-Path $releaseDirectory "bundle/msi"

if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
    throw "Expected Windows application executable was not produced: '$applicationPath'."
}

$nsisInstallers = @(Get-ChildItem -LiteralPath $nsisDirectory -Filter "*.exe" -File -ErrorAction SilentlyContinue)
$msiInstallers = @(Get-ChildItem -LiteralPath $msiDirectory -Filter "*.msi" -File -ErrorAction SilentlyContinue)

if ($nsisInstallers.Count -eq 0) {
    throw "No NSIS installer was produced in '$nsisDirectory'."
}
if ($msiInstallers.Count -eq 0) {
    throw "No MSI installer was produced in '$msiDirectory'."
}

$artifacts = @((Get-Item -LiteralPath $applicationPath)) + $nsisInstallers + $msiInstallers
$installers = $nsisInstallers + $msiInstallers
$authenticodeIssues = @()

foreach ($installer in $installers) {
    $updaterSignaturePath = "$($installer.FullName).sig"
    if (-not (Test-Path -LiteralPath $updaterSignaturePath -PathType Leaf)) {
        throw "No Tauri updater signature was produced for '$($installer.FullName)'."
    }
    if ((Get-Item -LiteralPath $updaterSignaturePath).Length -eq 0) {
        throw "The Tauri updater signature is empty: '$updaterSignaturePath'."
    }
}

foreach ($artifact in $artifacts) {
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
            throw "'$($artifact.FullName)' contains a non-valid Authenticode signature: $($signature.Status) ($($signature.StatusMessage))"
        }

        $authenticodeIssues += "Authenticode verification failed for '$($artifact.FullName)': $($signature.Status) ($($signature.StatusMessage))"
        continue
    }
    if ($null -eq $signature.SignerCertificate) {
        $authenticodeIssues += "No Authenticode signer certificate was found for '$($artifact.FullName)'."
        continue
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        $authenticodeIssues += "No Authenticode timestamp was found for '$($artifact.FullName)'."
        continue
    }

    Write-Host "Verified $($artifact.FullName)"
    Write-Host "  Signer: $($signature.SignerCertificate.Subject)"
    Write-Host "  Thumbprint: $($signature.SignerCertificate.Thumbprint)"
}

if ($authenticodeIssues.Count -gt 0) {
    if ($signingRequired) {
        throw "Windows signature verification failed:`n$($authenticodeIssues -join "`n")"
    }

    foreach ($issue in $authenticodeIssues) {
        Write-Warning $issue
    }
    Write-Warning "WINDOWS_CODE_SIGNING_REQUIRED is false; unsigned Windows artifacts will be published."
} else {
    Write-Host "Verified $($artifacts.Count) Authenticode-signed artifacts."
}

Write-Host "Verified $($installers.Count) Tauri updater signatures."
