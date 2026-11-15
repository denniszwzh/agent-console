/** Session / thread ids are passed to CLIs as arguments: they must never be parseable as a flag. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}
