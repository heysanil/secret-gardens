/** Base class for every error thrown by @secret-gardens/crypto. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/** Invalid master-key input (missing/malformed env value, bad DEK size). */
export class MasterKeyError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

/** A wrapped DEK was produced by a different KEK than the loaded master key. */
export class KekMismatchError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = "KekMismatchError";
  }
}

/** GCM authentication failed while unwrapping a DEK. */
export class DekUnwrapError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = "DekUnwrapError";
  }
}

/** GCM authentication failed while decrypting a secret value. */
export class DecryptError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}
