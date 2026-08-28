export function redactSecrets(
  value: string,
  secrets: Iterable<string>,
): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length >= 4)
      redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(
    /\b(secret|token|authorization|api[_-]?key|password|credential)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
}
