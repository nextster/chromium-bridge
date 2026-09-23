# Chromium Bridge installer for Windows.
#
#   irm https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.ps1 | iex
#
# Pass a command or options through a script block:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.ps1))) uninstall --purge
#
# The body runs in its own scope so `iex` neither leaks variables into the
# caller's session nor closes the window on failure.
& {
  Set-StrictMode -Version 3.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repository = if ($env:CHROMIUM_BRIDGE_REPOSITORY) { $env:CHROMIUM_BRIDGE_REPOSITORY } else { 'nextster/chromium-bridge' }
  $ref = if ($env:CHROMIUM_BRIDGE_REF) { $env:CHROMIUM_BRIDGE_REF } else { 'v0.7.3' }
  $sourceDir = $env:CHROMIUM_BRIDGE_SOURCE_DIR
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  $stateDir = if ($env:CHROMIUM_BRIDGE_STATE_DIR) { $env:CHROMIUM_BRIDGE_STATE_DIR } else { Join-Path $userProfile '.chromium-bridge' }
  $nodeVersion = '24.19.0'
  # Official v24.19.0 SHASUMS256.txt values from nodejs.org.
  $nodeChecksums = @{
    'x64' = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
    'arm64' = '8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f'
  }

  $arguments = @($args)
  $command = 'install'
  if ($arguments.Count -gt 0 -and @('install', 'update', 'uninstall') -contains $arguments[0]) {
    $command = $arguments[0]
    $arguments = @($arguments | Select-Object -Skip 1)
  }
  $dryRun = $arguments -contains '--dry-run'

  function Test-Windows {
    return [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
  }

  # Returns the real node.exe behind a candidate, or $null. Version-manager
  # .cmd shims cannot be launched by browsers or MCP clients, and the .cmd
  # launchers can embed only ASCII paths outside the state directory.
  function Resolve-CompatibleNode([string] $candidate) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    try {
      $version = [string] (& $candidate --version)
    } catch {
      return $null
    }
    if ($version -notmatch '^v(\d+)\.' -or [int] $Matches[1] -lt 20) { return $null }
    $executable = $candidate
    if ($executable -notmatch '\.exe$') {
      try {
        $executable = [string] (& $candidate -p 'process.execPath')
      } catch {
        return $null
      }
      if ($executable -notmatch '\.exe$' -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $null }
    }
    $portableRoot = (Join-Path $stateDir 'node') + [IO.Path]::DirectorySeparatorChar
    if ($executable -match '[^\x20-\x7e]' -and -not $executable.StartsWith($portableRoot, [StringComparison]::OrdinalIgnoreCase)) {
      return $null
    }
    return $executable
  }

  function Find-Node {
    if ($env:CHROMIUM_BRIDGE_FORCE_PORTABLE_NODE -eq '1') { return $null }
    $pathNode = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
      $env:CHROMIUM_BRIDGE_NODE,
      (Join-Path (Join-Path $stateDir 'node') 'node.exe'),
      $(if ($pathNode) { $pathNode.Source } else { $null })
    )
    foreach ($candidate in $candidates) {
      $resolved = Resolve-CompatibleNode $candidate
      if ($resolved) { return $resolved }
    }
    return $null
  }

  function Get-NodeArchitecture {
    $architecture = $null
    try {
      $architecture = [string] [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    } catch {
      $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($architecture) {
      '^(X64|AMD64)$' { return 'x64' }
      '^(Arm64|ARM64)$' { return 'arm64' }
      default { throw "Unsupported Windows architecture: $architecture" }
    }
  }

  # Retries like install.sh's curl --retry 3; a flaky connection was the most
  # likely reason for a first attempt to fail.
  function Invoke-Download([string] $uri, [string] $destination) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $attempt = 0
    while ($true) {
      $attempt += 1
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $destination
        return
      } catch {
        if ($attempt -ge 4) { throw }
        Write-Warning "Download failed ($($_.Exception.Message)); retrying $uri"
        Start-Sleep -Seconds (2 * $attempt)
      }
    }
  }

  function Expand-Zip([string] $archive, [string] $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $tar = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32\tar.exe' } else { $null }
    if ($tar -and (Test-Path -LiteralPath $tar -PathType Leaf)) {
      # bsdtar ships with Windows 10 1803+ and extracts large archives much faster.
      & $tar -xf $archive -C $destination
      if ($LASTEXITCODE -ne 0) { throw "Could not extract $archive" }
    } else {
      Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
    }
  }

  function Get-FileSha256([string] $filePath) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant()
  }

  function Install-PortableNode {
    $nodeArch = Get-NodeArchitecture
    $expectedSha256 = $nodeChecksums[$nodeArch]
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $stage = Join-Path $stateDir (".node-install." + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    try {
      $archiveName = "node-v$nodeVersion-win-$nodeArch.zip"
      $archive = Join-Path $stage $archiveName
      if ($env:CHROMIUM_BRIDGE_TEST_NODE_ARCHIVE) {
        Copy-Item -LiteralPath $env:CHROMIUM_BRIDGE_TEST_NODE_ARCHIVE -Destination $archive
        if (-not $env:CHROMIUM_BRIDGE_TEST_NODE_SHA256) { throw 'Missing test Node SHA-256' }
        $expectedSha256 = $env:CHROMIUM_BRIDGE_TEST_NODE_SHA256
      } else {
        Write-Host "Installing verified Node.js v$nodeVersion runtime..."
        Invoke-Download "https://nodejs.org/dist/v$nodeVersion/$archiveName" $archive
      }
      if ((Get-FileSha256 $archive) -ne $expectedSha256) { throw 'Node.js archive checksum mismatch.' }

      $extractDir = Join-Path $stage 'extract'
      Expand-Zip $archive $extractDir
      $extracted = Join-Path $extractDir "node-v$nodeVersion-win-$nodeArch"
      if (-not (Test-Path -LiteralPath (Join-Path $extracted 'node.exe') -PathType Leaf)) {
        throw 'Node.js archive does not contain node.exe.'
      }
      $target = Join-Path $stateDir 'node'
      $backup = Join-Path $stateDir ("node.backup." + $PID)
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
      try {
        Move-Item -LiteralPath $extracted -Destination $target
      } catch {
        if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
          Move-Item -LiteralPath $backup -Destination $target
        }
        throw
      }
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
      return (Join-Path $target 'node.exe')
    } finally {
      if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
  }

  if (-not (Test-Windows) -and -not $dryRun) {
    throw 'install.ps1 is the Windows installer. On macOS run install.sh instead.'
  }

  $node = Find-Node
  if (-not $node) { $node = Install-PortableNode }

  $temporaryDir = $null
  $previousNode = $env:CHROMIUM_BRIDGE_NODE
  try {
    if (-not $sourceDir) {
      if ($repository -notmatch '^[A-Za-z0-9._/-]+$') { throw 'Invalid repository.' }
      if ($ref -notmatch '^[A-Za-z0-9._/-]+$') { throw 'Invalid ref.' }
      $temporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("chromium-bridge-" + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force -Path $temporaryDir | Out-Null
      $archive = Join-Path $temporaryDir 'source.zip'
      Invoke-Download "https://codeload.github.com/$repository/zip/$ref" $archive
      $extractDir = Join-Path $temporaryDir 'source'
      Expand-Zip $archive $extractDir
      $roots = @(Get-ChildItem -LiteralPath $extractDir -Directory)
      if ($roots.Count -ne 1) { throw 'Downloaded repository archive has an unexpected layout.' }
      $sourceDir = $roots[0].FullName
    }

    $scriptName = if ($command -eq 'uninstall') { 'uninstall.mjs' } else { 'setup.mjs' }
    $entryScript = Join-Path (Join-Path $sourceDir 'scripts') $scriptName
    if (-not (Test-Path -LiteralPath $entryScript -PathType Leaf)) {
      throw "Downloaded source does not contain scripts/$scriptName."
    }

    $env:CHROMIUM_BRIDGE_NODE = $node
    # Node writes progress to stderr; keep native stderr from becoming a terminating error.
    $ErrorActionPreference = 'Continue'
    & $node $entryScript @arguments
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -eq 2) {
      Write-Warning 'Chromium Bridge is installed but the browser is not ready yet. Follow the next steps above, then rerun the installer.'
    } elseif ($exitCode -ne 0) {
      throw "Chromium Bridge $command failed with exit code $exitCode."
    }
    if ($command -eq 'uninstall' -and -not $dryRun) {
      # uninstall.mjs cannot delete the portable node.exe that runs it.
      $portableNode = Join-Path $stateDir 'node'
      if ($node.StartsWith($portableNode + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $portableNode)) {
        try {
          Remove-Item -LiteralPath $portableNode -Recurse -Force
        } catch {
          Write-Warning "Could not remove $portableNode. Close browsers that use Chromium Bridge, then delete it."
        }
      }
      if ((Test-Path -LiteralPath $stateDir) -and -not (Get-ChildItem -LiteralPath $stateDir -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $stateDir -Force
      }
    }
  } finally {
    $env:CHROMIUM_BRIDGE_NODE = $previousNode
    if ($temporaryDir -and (Test-Path -LiteralPath $temporaryDir)) {
      Remove-Item -LiteralPath $temporaryDir -Recurse -Force
    }
  }
} @args
