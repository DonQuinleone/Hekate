export class StorageError extends Error {
  override name = "StorageError";
}

export class ObjectNotFoundError extends StorageError {
  override name = "ObjectNotFoundError";
  readonly key: string;
  constructor(key: string) {
    super(`No object at "${key}"`);
    this.key = key;
  }
}

export class RangeNotSatisfiableError extends StorageError {
  override name = "RangeNotSatisfiableError";
}

export class InvalidKeyError extends StorageError {
  override name = "InvalidKeyError";
}

export class StorageConfigError extends StorageError {
  override name = "StorageConfigError";
}
