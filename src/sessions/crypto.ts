import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12   // 96-bit IV recommended for GCM
const TAG_LENGTH = 16  // 128-bit auth tag

export interface EncryptedPayload {
  encrypted: string  // base64 ciphertext
  iv: string         // base64
  tag: string        // base64 auth tag
}

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })

  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')

  return {
    encrypted,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(tag)

  let decrypted = decipher.update(payload.encrypted, 'base64', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
