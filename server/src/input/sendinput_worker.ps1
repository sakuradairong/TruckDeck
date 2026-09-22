# TruckDeck SendInput worker (Windows only)
# stdin: JSON lines  {"op":"tap","vk":76,"downMs":50} | {"op":"quit"}
# stdout: JSON lines {"ok":true,"ready":true} then per-op results
# Docs: https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-input
#       https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
#       https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput
# INPUT must include MOUSE/KEYBD/HARDWARE union; x64 sizeof(INPUT)=40, x86=28.

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class TDInput {
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_SCANCODE = 0x0008;
  public const uint MAPVK_VK_TO_VSC = 0;

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint uCode, uint uMapType);

  static bool IsExtendedVk(ushort vk) {
    switch (vk) {
      case 0x21: case 0x22: case 0x23: case 0x24:
      case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2D: case 0x2E:
      case 0xA3: case 0xA5:
        return true;
      default:
        return false;
    }
  }

  static INPUT Build(ushort vk, bool keyUp) {
    uint scan = MapVirtualKey(vk, MAPVK_VK_TO_VSC);
    uint flags = KEYEVENTF_SCANCODE;
    if (IsExtendedVk(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
    if (keyUp) flags |= KEYEVENTF_KEYUP;
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki.wVk = 0;
    input.U.ki.wScan = (ushort)scan;
    input.U.ki.dwFlags = flags;
    input.U.ki.time = 0;
    input.U.ki.dwExtraInfo = IntPtr.Zero;
    return input;
  }

  static void SendOne(INPUT input) {
    INPUT[] arr = new INPUT[] { input };
    int size = Marshal.SizeOf(typeof(INPUT));
    uint sent = SendInput(1, arr, size);
    if (sent != 1) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput failed (sent=" + sent + ", cbSize=" + size + ")");
    }
  }

  public static void Tap(ushort vk, int downMs) {
    SendOne(Build(vk, false));
    System.Threading.Thread.Sleep(downMs);
    SendOne(Build(vk, true));
  }

  public static void Up(ushort vk) {
    SendOne(Build(vk, true));
  }

  public static int InputSize() {
    return Marshal.SizeOf(typeof(INPUT));
  }
}
"@

$held = New-Object 'System.Collections.Generic.HashSet[int]'

function Release-All {
  foreach ($vk in @($held)) {
    try { [TDInput]::Up([uint16]$vk) } catch {}
    [void]$held.Remove($vk)
  }
}

$size = [TDInput]::InputSize()
@{ ok = $true; ready = $true; inputSize = $size } | ConvertTo-Json -Compress | Write-Output

function Write-Msg([hashtable]$obj) {
  ($obj | ConvertTo-Json -Compress) | Write-Output
}

try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    try {
      $msg = $line | ConvertFrom-Json
    } catch {
      Write-Msg @{ ok = $false; error = 'bad-json' }
      continue
    }
    $rid = $msg.id
    if ($msg.op -eq 'quit') { break }
    if ($msg.op -eq 'tap') {
      $vk = [int]$msg.vk
      $ms = [int]$msg.downMs
      if ($vk -lt 1 -or $vk -gt 254) {
        Write-Msg @{ ok = $false; error = 'bad-vk'; id = $rid }
        continue
      }
      if ($ms -lt 1) { $ms = 1 }
      if ($ms -gt 500) { $ms = 500 }
      [void]$held.Add($vk)
      try {
        [TDInput]::Tap([uint16]$vk, $ms)
        Write-Msg @{ ok = $true; id = $rid }
      } catch {
        $err = ($_ | Out-String).Trim()
        Write-Msg @{ ok = $false; error = 'sendinput'; message = $err; id = $rid }
      } finally {
        try { [TDInput]::Up([uint16]$vk) } catch {}
        [void]$held.Remove($vk)
      }
      continue
    }
    Write-Msg @{ ok = $false; error = 'unknown-op'; id = $rid }
  }
} finally {
  Release-All
}
