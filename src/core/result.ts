// Result<T, E> for expected failures such as validation errors (DESIGN.md 4.4, 11).
// Throwing is reserved for programmer errors.

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
