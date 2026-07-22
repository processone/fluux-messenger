param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$signingRequired = $env:WINDOWS_CODE_SIGNING_REQUIRED -eq "true"

$requiredEnvironmentVariables = @(
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE"
)

$missingEnvironmentVariables = @(
    $requiredEnvironmentVariables | Where-Object {
        [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
    }
)

if ($missingEnvironmentVariables.Count -gt 0) {
    $message = "Windows code signing is unavailable because these environment variables are missing: $($missingEnvironmentVariables -join ', ')."
    if ($signingRequired) {
        throw $message
    }

    Write-Warning "$message Continuing without an Authenticode signature."
    exit 0
}

$resolvedPath = (Resolve-Path -LiteralPath $FilePath).Path

Write-Host "Signing $resolvedPath with Azure Artifact Signing"
& artifact-signing-cli `
    -e $env:AZURE_SIGNING_ENDPOINT `
    -a $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
    -c $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE `
    -d "Fluux Messenger" `
    $resolvedPath

if ($LASTEXITCODE -ne 0) {
    $message = "Azure Artifact Signing failed for '$resolvedPath' with exit code $LASTEXITCODE."
    if ($signingRequired) {
        throw $message
    }

    $failedSignature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
    if ($failedSignature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
        throw "$message The failed attempt left a non-valid signature ($($failedSignature.Status)); refusing to package the file."
    }

    Write-Warning "$message Continuing without an Authenticode signature."
    exit 0
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    $message = "Authenticode verification failed for '$resolvedPath': $($signature.Status) ($($signature.StatusMessage))"
    if ($signingRequired) {
        throw $message
    }

    Write-Warning "$message Continuing with the produced file."
    exit 0
}
if ($null -eq $signature.SignerCertificate) {
    $message = "No Authenticode signer certificate was found for '$resolvedPath'."
    if ($signingRequired) {
        throw $message
    }

    Write-Warning "$message Continuing with the produced file."
    exit 0
}
if ($null -eq $signature.TimeStamperCertificate) {
    $message = "No Authenticode timestamp was found for '$resolvedPath'."
    if ($signingRequired) {
        throw $message
    }

    Write-Warning "$message Continuing with the produced file."
    exit 0
}

Write-Host "Verified Authenticode signature: $resolvedPath"
Write-Host "  Signer: $($signature.SignerCertificate.Subject)"
Write-Host "  Thumbprint: $($signature.SignerCertificate.Thumbprint)"
Write-Host "  Timestamp authority: $($signature.TimeStamperCertificate.Subject)"
