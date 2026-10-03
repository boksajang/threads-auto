export function redactForUi(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?[^\r\n,;]+/gi, 'Authorization=[숨김]')
    .replace(/(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[숨김]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[비밀 값 숨김]')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[매개변수 숨김]')
    .replace(/[A-Z]:\\[^\r\n]+/gi, '[로컬 경로]')
    .slice(0, 1_000);
}
