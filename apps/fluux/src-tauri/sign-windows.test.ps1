#!/usr/bin/env pwsh
#
# Regression tests for sign-windows.ps1.
#
# Windows code signing is optional: WINDOWS_CODE_SIGNING_REQUIRED decides
# whether a signing failure stops the release or only leaves the artifact
# unsigned. These tests pin that contract for the failure modes the hook can
# actually meet — absent credentials, an absent CLI, a CLI that fails, and a CLI
# that reports success without producing a signature.
#
# The bundler runs the hook as `powershell.exe -File ... "%1"` with stdout and
# stderr piped into the bundler. That exact combination — Windows PowerShell,
# not pwsh, with redirected output — is what turns a native command's stderr
# into an error record, so the tests reproduce it rather than calling the hook
# in-process, where the hazard does not exist.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$signScript = Join-Path $PSScriptRoot "sign-windows.ps1"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

$azureCredentials = @{
    AZURE_TENANT_ID                            = "00000000-0000-0000-0000-000000000000"
    AZURE_CLIENT_ID                            = "00000000-0000-0000-0000-000000000001"
    AZURE_CLIENT_SECRET                        = "test-secret"
    AZURE_SIGNING_ENDPOINT                     = "https://wus.codesigning.azure.net"
    AZURE_ARTIFACT_SIGNING_ACCOUNT             = "test-account"
    AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE = "test-profile"
}

$script:failures = @()

function New-Sandbox {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("fluux-sign-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    return $root
}

function New-UnsignedArtifact {
    param([string]$Root)

    # Get-AuthenticodeSignature reports NotSigned for an unsigned PowerShell
    # script just as it does for an unsigned binary, so a .ps1 stands in for the
    # bundled executable without committing a PE fixture.
    $path = Join-Path $Root "artifact.ps1"
    Set-Content -LiteralPath $path -Value "# unsigned test artifact"
    return $path
}

function New-FakeSigningCli {
    param(
        [string]$Root,
        [int]$ExitCode,
        [switch]$WriteStderr
    )

    $binDirectory = Join-Path $Root "bin"
    New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null

    $lines = @("@echo off")
    if ($WriteStderr) {
        $lines += "echo AADSTS7000222: The provided client secret keys for app are expired. 1>&2"
    }
    $lines += "exit /b $ExitCode"
    Set-Content -LiteralPath (Join-Path $binDirectory "artifact-signing-cli.cmd") -Value $lines

    return $binDirectory
}

function Invoke-SignHook {
    param(
        [string]$ArtifactPath,
        [string]$LogPath,
        [hashtable]$Environment,
        [string]$SearchPath
    )

    $names = @($azureCredentials.Keys) + @("WINDOWS_CODE_SIGNING_REQUIRED", "WINDOWS_SIGNING_LOG", "PATH")
    $saved = @{}
    foreach ($name in $names) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    }

    try {
        foreach ($name in $names) {
            [Environment]::SetEnvironmentVariable($name, $null)
        }
        foreach ($name in $Environment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $Environment[$name])
        }
        [Environment]::SetEnvironmentVariable("WINDOWS_SIGNING_LOG", $LogPath)
        [Environment]::SetEnvironmentVariable("PATH", $SearchPath)

        # Merging stderr is what the bundler does, and under `Stop` the merge
        # would abort this test the way it aborts the hook. Judge the child by
        # its exit code instead.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $output = & $windowsPowerShell -NoLogo -NoProfile -NonInteractive `
                -ExecutionPolicy Bypass -File $signScript $ArtifactPath 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }

        $log = if (Test-Path -LiteralPath $LogPath) {
            (Get-Content -LiteralPath $LogPath -Raw)
        } else {
            ""
        }

        return [pscustomobject]@{
            ExitCode = $exitCode
            Output   = ($output | Out-String)
            Log      = $log
        }
    } finally {
        foreach ($name in $names) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name])
        }
    }
}

function Assert-Case {
    param(
        [string]$Name,
        [pscustomobject]$Result,
        [switch]$ExpectSuccess,
        [string]$ExpectLogMatch
    )

    $problems = @()

    if ($ExpectSuccess) {
        if ($Result.ExitCode -ne 0) {
            $problems += "expected exit code 0, got $($Result.ExitCode)"
        }
    } elseif ($Result.ExitCode -eq 0) {
        $problems += "expected a non-zero exit code, got 0"
    }

    if ($ExpectLogMatch -and $Result.Log -notmatch [regex]::Escape($ExpectLogMatch)) {
        $problems += "expected the signing log to mention '$ExpectLogMatch'"
    }

    if ($problems.Count -eq 0) {
        Write-Host "  PASS  $Name"
        return
    }

    Write-Host "  FAIL  $Name"
    foreach ($problem in $problems) {
        Write-Host "        $problem"
    }
    if ($Result.Log) {
        Write-Host "        --- signing log ---"
        foreach ($line in ($Result.Log -split "`r?`n")) {
            if ($line) { Write-Host "        $line" }
        }
    }
    if ($Result.Output) {
        Write-Host "        --- hook output ---"
        foreach ($line in ($Result.Output -split "`r?`n")) {
            if ($line) { Write-Host "        $line" }
        }
    }
    $script:failures += $Name
}

function Get-BaseSearchPath {
    return (Join-Path $env:SystemRoot "System32") + ";" + $env:SystemRoot
}

$sandbox = New-Sandbox
try {
    $basePath = Get-BaseSearchPath
    $case = 0

    function New-Case {
        param([string]$Label)
        $script:case++
        $root = Join-Path $sandbox "case$script:case"
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Write-Host $Label
        return [pscustomobject]@{
            Artifact = (New-UnsignedArtifact -Root $root)
            Log      = (Join-Path $root "windows-signing.log")
            Root     = $root
        }
    }

    # --- Credentials absent ---------------------------------------------------

    $context = New-Case "Azure credentials absent"
    Assert-Case -Name "signing optional -> the artifact is bundled unsigned" -ExpectSuccess `
        -ExpectLogMatch "environment variables are missing" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $basePath -Environment @{ WINDOWS_CODE_SIGNING_REQUIRED = "false" })

    Assert-Case -Name "signing required -> the build stops" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $basePath -Environment @{ WINDOWS_CODE_SIGNING_REQUIRED = "true" })

    # --- CLI absent from PATH -------------------------------------------------

    $context = New-Case "artifact-signing-cli absent from PATH"
    Assert-Case -Name "signing optional -> the artifact is bundled unsigned" -ExpectSuccess `
        -ExpectLogMatch "artifact-signing-cli" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $basePath -Environment ($azureCredentials + @{ WINDOWS_CODE_SIGNING_REQUIRED = "false" }))

    # --- CLI fails, as an expired client secret makes it fail ------------------

    $context = New-Case "artifact-signing-cli fails and reports on stderr"
    $cliPath = (New-FakeSigningCli -Root $context.Root -ExitCode 1 -WriteStderr) + ";" + $basePath

    Assert-Case -Name "signing optional -> the artifact is bundled unsigned" -ExpectSuccess `
        -ExpectLogMatch "exit code 1" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $cliPath -Environment ($azureCredentials + @{ WINDOWS_CODE_SIGNING_REQUIRED = "false" }))

    Assert-Case -Name "signing required -> the build stops" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $cliPath -Environment ($azureCredentials + @{ WINDOWS_CODE_SIGNING_REQUIRED = "true" }))

    # --- CLI succeeds without producing a signature ---------------------------

    $context = New-Case "artifact-signing-cli succeeds but leaves the artifact unsigned"
    $cliPath = (New-FakeSigningCli -Root $context.Root -ExitCode 0) + ";" + $basePath

    Assert-Case -Name "signing optional -> the artifact is bundled unsigned" -ExpectSuccess `
        -ExpectLogMatch "NotSigned" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $cliPath -Environment ($azureCredentials + @{ WINDOWS_CODE_SIGNING_REQUIRED = "false" }))

    Assert-Case -Name "signing required -> the build stops" `
        -Result (Invoke-SignHook -ArtifactPath $context.Artifact -LogPath $context.Log `
            -SearchPath $cliPath -Environment ($azureCredentials + @{ WINDOWS_CODE_SIGNING_REQUIRED = "true" }))
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""

if ($script:failures.Count -gt 0) {
    Write-Host "$($script:failures.Count) Windows signing hook case(s) failed: $($script:failures -join '; ')"
    exit 1
}

Write-Host "Windows signing hook honours WINDOWS_CODE_SIGNING_REQUIRED in every failure mode."

# Each case ran the hook as a child process, so $LASTEXITCODE still carries the
# exit code of the last one, and the cases that must stop a build leave it at 1.
# The CI shell exits on that value unless this script sets its own.
exit 0
