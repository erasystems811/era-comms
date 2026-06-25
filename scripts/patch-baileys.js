// Patches Baileys crypto.js to handle non-Buffer objects on Android ARM32 / Node.js v24.
// Run once after npm install: node scripts/patch-baileys.js

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const cryptoPath = resolve(__dir, '../node_modules/@whiskeysockets/baileys/lib/Utils/crypto.js')

let src = readFileSync(cryptoPath, 'utf8')

if (src.includes('// patched-arm32')) {
  console.log('Already patched.')
  process.exit(0)
}

// Add a helper that converts any value to a proper Node.js Buffer
const helper = `// patched-arm32
function toNodeBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return Buffer.from(v);
}
`

// Patch aesEncryptGCM — wrap buffer args
src = src.replace(
  'aes.setAAD(additionalData)',
  'aes.setAAD(toNodeBuffer(additionalData))'
)
src = src.replace(
  'aes.update(buffer)',
  'aes.update(toNodeBuffer(buffer))'
)

// Same fix for aesDecryptGCM if it exists
src = src.replace(
  /decipher\.update\(buffer\)/g,
  'decipher.update(toNodeBuffer(buffer))'
)

src = helper + src

writeFileSync(cryptoPath, src)
console.log('Baileys crypto.js patched successfully.')
