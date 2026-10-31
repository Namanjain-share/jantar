import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';

/** Time-sortable id (ulid). */
export function newId(): string {
  return ulid();
}

/** Unguessable id: ulid plus 96 random bits (pending cards, send jobs). */
export function newSecretId(): string {
  return `${ulid()}${randomBytes(12).toString('base64url')}`;
}

/** Random token (base64url). 16 bytes = 128 bits (pairing codes), 32 = device keys. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
