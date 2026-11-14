/** crypto.subtle only exists on HTTPS pages and on localhost. */
export function assertSecureContext() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This page must be opened over HTTPS (or on localhost) to verify and decrypt music.');
  }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The key is imported as non-extractable and is never written to any storage. */
export async function importTrackKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

/** Stored layout: 12-byte IV, then ciphertext and GCM tag. */
export async function decryptChunk(key: CryptoKey, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}
