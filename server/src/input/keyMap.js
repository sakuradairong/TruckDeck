'use strict';

/** Virtual-key whitelist used by Windows SendInput worker. Short letters map to VK codes. */

const VK = {
  Space: 0x20,
  Tab: 0x09,
  Escape: 0x1b,
  Enter: 0x0d,
  Backspace: 0x08,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Semicolon: 0xba,
  Quote: 0xde,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  Backslash: 0xdc,
  Minus: 0xbd,
  Equal: 0xbb,
  Backquote: 0xc0,
  ArrowUp: 0x26,
  ArrowDown: 0x28,
  ArrowLeft: 0x25,
  ArrowRight: 0x27,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Insert: 0x2d,
  Delete: 0x2e,
};

for (let i = 0; i < 26; i += 1) {
  const letter = String.fromCharCode(65 + i);
  VK[letter] = 0x41 + i;
  VK[`Key${letter}`] = 0x41 + i;
}
for (let i = 0; i < 10; i += 1) {
  VK[String(i)] = 0x30 + i;
  VK[`Digit${i}`] = 0x30 + i;
}
for (let i = 1; i <= 12; i += 1) {
  VK[`F${i}`] = 0x70 + (i - 1);
}

function resolveVk(keyName) {
  if (typeof keyName !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(VK, keyName)) return null;
  return VK[keyName];
}

module.exports = { VK, resolveVk };
