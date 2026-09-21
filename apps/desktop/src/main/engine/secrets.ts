// Secrets at rest: a value is stored only encrypted with the OS keychain-backed key that
// Electron's safeStorage wraps, as base64 in settings.json. The encryptor is injected so the
// store runs (and its tests run) without Electron; the Electron one is built in index.ts.

export interface Encryptor {
  /** False when the OS cannot protect a key (no keychain, no login session); nothing is stored then. */
  available: () => boolean;
  /** Plain text → base64 of the ciphertext. */
  encrypt: (plain: string) => string;
  /** Base64 of the ciphertext → plain text; throws when the ciphertext does not decrypt. */
  decrypt: (encoded: string) => string;
}

export class SecretError extends Error {
  constructor(message: string) { super(message); this.name = "SecretError"; }
}

export const ENCRYPTION_UNAVAILABLE_MESSAGE = "This machine cannot encrypt secrets (Electron's safeStorage is unavailable: no keychain or login session), so the key was not stored.";

/** Electron's safeStorage as an Encryptor; the module is passed in so this file stays free of Electron at import time. */
export function electronEncryptor(safeStorage: { isEncryptionAvailable: () => boolean; encryptString: (plain: string) => Buffer; decryptString: (encrypted: Buffer) => string }): Encryptor {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
  };
}

/** Encrypts for storage; refuses (with the reason) rather than storing plain text when encryption is unavailable. */
export function sealSecret(encryptor: Encryptor, plain: string): string {
  if (!encryptor.available()) throw new SecretError(ENCRYPTION_UNAVAILABLE_MESSAGE);
  const sealed = encryptor.encrypt(plain);
  if (typeof sealed !== "string" || sealed.length === 0) throw new SecretError("Encrypting the secret produced nothing; it was not stored.");
  return sealed;
}

/** Decrypts a stored value; a value that no longer decrypts (another user, a reset keychain) is an explicit error, never an empty key. */
export function openSecret(encryptor: Encryptor, sealed: string, name: string): string {
  if (!encryptor.available()) throw new SecretError(`The stored ${name} cannot be decrypted right now: Electron's safeStorage is unavailable.`);
  let plain: string;
  try { plain = encryptor.decrypt(sealed); }
  catch (error) { throw new SecretError(`The stored ${name} could not be decrypted (${error instanceof Error ? error.message : String(error)}). Remove it and enter it again.`); }
  if (plain.length === 0) throw new SecretError(`The stored ${name} decrypted to nothing. Remove it and enter it again.`);
  return plain;
}
