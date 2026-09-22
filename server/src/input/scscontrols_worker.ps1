# TruckDeck SCS controls worker (ASCII only, Windows PowerShell 5.1 compatible).
#
# Writes semantic input events into the scs_sdk_controller shared memory
# (Local\SCSControls) so the game acts on them without any keyboard injection.
# Offsets come from scsControlOffsets.json (generated from the plugin's inputs.h).
#
# Protocol: one JSON request per line on stdin, one JSON reply per line on stdout.
#   startup                                  -> {"ok":true,"ready":true,"bytes":342,"id":0}
#   {"op":"probe","id":1}                    -> {"ok":true,"ready":true,"bytes":342,"id":1}
#   {"op":"set","name":"lightpark","value":true,"id":2}
#   {"op":"pulse","name":"flasher4way","holdMs":120,"id":3}
#   {"op":"quit","id":4}
#
# Warning: the plugin itself is known to leave the wipers cycling at max level
# after load; sending the "wipers0" control resets them.

param(
  [Parameter(Mandatory = $true)][string]$OffsetsJson
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ScsShm
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenFileMapping(uint dwDesiredAccess, bool bInheritHandle, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr MapViewOfFile(IntPtr hFileMappingObject, uint dwDesiredAccess,
        uint dwFileOffsetHigh, uint dwFileOffsetLow, UIntPtr dwNumberOfBytesToMap);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UnmapViewOfFile(IntPtr lpBaseAddress);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
"@

$FILE_MAP_ALL_ACCESS = 0x000F001F

$script:Json = Get-Content -Raw -Path $OffsetsJson | ConvertFrom-Json
$script:Controls = $script:Json.controls
$script:TotalBytes = [int]$script:Json._totalBytes
$script:Base = [IntPtr]::Zero
$script:Handle = [IntPtr]::Zero

function Write-Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Open-Shm {
  if ($script:Base -ne [IntPtr]::Zero) { return @{ ok = $true } }
  $h = [ScsShm]::OpenFileMapping($FILE_MAP_ALL_ACCESS, $false, 'Local\SCSControls')
  if ($h -eq [IntPtr]::Zero) {
    return @{ ok = $false; error = 'shared-memory-not-found'; code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  }
  $p = [ScsShm]::MapViewOfFile($h, $FILE_MAP_ALL_ACCESS, 0, 0, [UIntPtr]::Zero)
  if ($p -eq [IntPtr]::Zero) {
    [void][ScsShm]::CloseHandle($h)
    return @{ ok = $false; error = 'map-view-failed'; code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  }
  $script:Handle = $h
  $script:Base = $p
  return @{ ok = $true }
}

function Close-Shm {
  if ($script:Base -ne [IntPtr]::Zero) {
    [void][ScsShm]::UnmapViewOfFile($script:Base)
    $script:Base = [IntPtr]::Zero
  }
  if ($script:Handle -ne [IntPtr]::Zero) {
    [void][ScsShm]::CloseHandle($script:Handle)
    $script:Handle = [IntPtr]::Zero
  }
}

function Write-Control([string]$Name, [bool]$Value) {
  $prop = $script:Controls.PSObject.Properties[$Name]
  if ($null -eq $prop) { return @{ ok = $false; error = 'unknown-control'; name = $Name } }
  $ctl = $prop.Value
  $offset = [int]$ctl.offset
  if ($ctl.type -eq 'bool') {
    $byte = 0
    if ($Value) { $byte = 1 }
    [System.Runtime.InteropServices.Marshal]::WriteByte($script:Base, $offset, [byte]$byte)
  } elseif ($ctl.type -eq 'float') {
    $v = 0.0
    if ($Value) { $v = 1.0 }
    $raw = [BitConverter]::ToInt32([BitConverter]::GetBytes([float]$v), 0)
    [System.Runtime.InteropServices.Marshal]::WriteInt32($script:Base, $offset, $raw)
  } else {
    return @{ ok = $false; error = 'unsupported-type'; name = $Name }
  }
  return @{ ok = $true }
}

# ---- main loop -------------------------------------------------------------

$probe = Open-Shm
if ($probe.ok) {
  Write-Reply @{ ok = $true; ready = $true; bytes = $script:TotalBytes; id = 0 }
} else {
  Write-Reply @{ ok = $false; ready = $false; error = $probe.error; code = $probe.code; id = 0 }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $msg = $null
  try {
    $msg = $line | ConvertFrom-Json
  } catch {
    Write-Reply @{ ok = $false; error = 'bad-json'; id = 0 }
    continue
  }

  $id = 0
  if ($null -ne $msg.id) { $id = [int]$msg.id }

  switch ($msg.op) {
    'quit' {
      Close-Shm
      Write-Reply @{ ok = $true; id = $id }
      exit 0
    }
    'probe' {
      $r = Open-Shm
      if ($r.ok) {
        Write-Reply @{ ok = $true; ready = $true; bytes = $script:TotalBytes; id = $id }
      } else {
        Write-Reply @{ ok = $false; error = $r.error; code = $r.code; id = $id }
      }
    }
    'set' {
      $r = Open-Shm
      if (-not $r.ok) { Write-Reply @{ ok = $false; error = $r.error; code = $r.code; id = $id }; continue }
      $w = Write-Control ([string]$msg.name) ([bool]$msg.value)
      if ($w.ok) {
        Write-Reply @{ ok = $true; name = [string]$msg.name; id = $id }
      } else {
        Write-Reply @{ ok = $false; error = $w.error; name = [string]$msg.name; id = $id }
      }
    }
    'pulse' {
      $r = Open-Shm
      if (-not $r.ok) { Write-Reply @{ ok = $false; error = $r.error; code = $r.code; id = $id }; continue }
      $hold = 120
      if ($null -ne $msg.holdMs) { $hold = [int]$msg.holdMs }
      if ($hold -lt 20) { $hold = 20 }
      if ($hold -gt 2000) { $hold = 2000 }
      $name = [string]$msg.name
      $w1 = Write-Control $name $true
      if (-not $w1.ok) { Write-Reply @{ ok = $false; error = $w1.error; name = $name; id = $id }; continue }
      Start-Sleep -Milliseconds $hold
      $w2 = Write-Control $name $false
      if (-not $w2.ok) { Write-Reply @{ ok = $false; error = $w2.error; name = $name; id = $id }; continue }
      Write-Reply @{ ok = $true; name = $name; holdMs = $hold; id = $id }
    }
    default {
      Write-Reply @{ ok = $false; error = 'unknown-op'; id = $id }
    }
  }
}

Close-Shm
