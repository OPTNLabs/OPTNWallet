const MAX_EVENTS = 100;
const MAX_TEXT_LENGTH = 240;
const SENSITIVE_VALUE =
  /(mnemonic|seed phrase|recovery phrase|private key|xprv|keystore password|wallet password|secret)/gi;

export interface DiagnosticEvent {
  readonly name: string;
  readonly timestamp: string;
  readonly details: Readonly<Record<string, string>>;
}

const events: DiagnosticEvent[] = [];

function sanitizeText(value: unknown): string {
  const text = String(value ?? '')
    .replace(SENSITIVE_VALUE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_TEXT_LENGTH
    ? `${text.slice(0, MAX_TEXT_LENGTH)}…`
    : text;
}

function sanitizeDetails(details: Record<string, unknown> | undefined) {
  if (!details) return {};
  return Object.fromEntries(
    Object.entries(details)
      .slice(0, 20)
      .map(([key, value]) => [sanitizeText(key), sanitizeText(value)])
  );
}

/**
 * Records bounded, redacted, in-memory diagnostics only.
 *
 * This intentionally has no persistence, network transport, wallet-state
 * access, or automatic telemetry. Any future export path requires a separate
 * privacy and security review.
 */
export function recordDiagnostic(
  name: string,
  details?: Record<string, unknown>
): void {
  events.push({
    name: sanitizeText(name),
    timestamp: new Date().toISOString(),
    details: sanitizeDetails(details),
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function getDiagnostics(): readonly DiagnosticEvent[] {
  return events.map((event) => ({
    ...event,
    details: { ...event.details },
  }));
}

export function clearDiagnostics(): void {
  events.length = 0;
}
