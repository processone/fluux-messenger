param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# WINDOWS_CODE_SIGNING_REQUIRED is the single switch deciding what an
# unavailable signing service costs: "true" stops the release, anything else
# ships the artifact unsigned. Every failure below routes through the one
# handler at the bottom of this file so that no unanticipated error can escape
# that policy.
$signingRequired = $env:WINDOWS_CODE_SIGNING_REQUIRED -eq "true"

# The Tauri bundler runs this file as a per-artifact sign command and discards
# its stdout and stderr, so nothing written to the host reaches the CI log.
# Diagnostics are appended to a log file the workflow prints after the build.
$logPath = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_LOG)) {
    Join-Path $PSScriptRoot "target/windows-signing.log"
} else {
    $env:WINDOWS_SIGNING_LOG
}

$requiredEnvironmentVariables = @(
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE"
)

function Write-SigningLog {
    param([string]$Message)

    $line = "[{0}] {1}" -f (Get-Date -Format "o"), $Message
    Write-Host $line

    try {
        $directory = Split-Path -Parent $logPath
        if ($directory -and -not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        Add-Content -LiteralPath $logPath -Value $line
    } catch {
        # An unwritable log must never be the reason a build fails.
    }
}

function Invoke-Signing {
    param([string]$Path)

    $missingEnvironmentVariables = @(
        $requiredEnvironmentVariables | Where-Object {
            [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
        }
    )
    if ($missingEnvironmentVariables.Count -gt 0) {
        throw "Windows code signing is unavailable because these environment variables are missing: $($missingEnvironmentVariables -join ', ')."
    }

    $cli = @(Get-Command "artifact-signing-cli" -CommandType Application -ErrorAction SilentlyContinue)
    if ($cli.Count -eq 0) {
        throw "artifact-signing-cli was not found on PATH."
    }

    Write-SigningLog "Signing $Path with Azure Artifact Signing"

    # The CLI reports progress and failures on stderr. Windows PowerShell turns
    # a native command's stderr into error records whenever its output is
    # redirected, which under `Stop` aborts the script before its exit code can
    # be read — so judge the call by its exit code alone.
    $output = $null
    $exitCode = $null
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $cli[0].Source `
            -e $env:AZURE_SIGNING_ENDPOINT `
            -a $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
            -c $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE `
            -d "Fluux Messenger" `
            $Path 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($output) {
        Write-SigningLog "artifact-signing-cli said:`n$(($output | Out-String).TrimEnd())"
    }

    if ($exitCode -ne 0) {
        throw "Azure Artifact Signing failed for '$Path' with exit code $exitCode."
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode verification failed for '$Path': $($signature.Status) ($($signature.StatusMessage))"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "No Authenticode signer certificate was found for '$Path'."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "No Authenticode timestamp was found for '$Path'."
    }

    Write-SigningLog "Verified Authenticode signature: $Path"
    Write-SigningLog "  Signer: $($signature.SignerCertificate.Subject)"
    Write-SigningLog "  Thumbprint: $($signature.SignerCertificate.Thumbprint)"
    Write-SigningLog "  Timestamp authority: $($signature.TimeStamperCertificate.Subject)"
}

function Get-ResidualSignatureStatus {
    param([string]$Path)

    try {
        return (Get-AuthenticodeSignature -LiteralPath $Path).Status
    } catch {
        return $null
    }
}

$exitCode = 0
try {
    Invoke-Signing -Path (Resolve-Path -LiteralPath $FilePath).Path
} catch {
    $reason = $_.Exception.Message

    if ($signingRequired) {
        Write-SigningLog "$reason Windows code signing is required, so the build stops here."
        $exitCode = 1
    } else {
        # Windows treats a broken signature as tampering, which is worse than no
        # signature at all. An attempt that left one behind is not something the
        # fallback may ship.
        $residualStatus = Get-ResidualSignatureStatus -Path $FilePath
        $residualIsUsable = $null -eq $residualStatus -or
            $residualStatus -eq [System.Management.Automation.SignatureStatus]::NotSigned -or
            $residualStatus -eq [System.Management.Automation.SignatureStatus]::Valid

        if ($residualIsUsable) {
            Write-SigningLog "$reason Continuing without an Authenticode signature."
        } else {
            Write-SigningLog "$reason The attempt left a $residualStatus signature behind; refusing to package the file."
            $exitCode = 1
        }
    }
}

exit $exitCode
