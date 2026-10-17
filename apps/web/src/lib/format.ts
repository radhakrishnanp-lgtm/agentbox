/** Short "Chrome on macOS" style label from a user-agent string. */
export function describeUserAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

const CLI_NAMES: [RegExp, string][] = [
  [/^claude-cli$/i, 'Claude Code'],
  [/^codex/i, 'Codex'],
  [/^opencode$/i, 'OpenCode'],
  [/^grok/i, 'Grok CLI'],
  [/^GeminiCLI$/i, 'Gemini CLI'],
  [/^curl$/i, 'curl'],
];

/**
 * Short label for the program behind a request: "Chrome on Windows" for a
 * browser, "Claude Code 2.1.0" for a CLI. The raw text is shown in Details.
 */
export function describeClient(ua: string): string {
  const ps = /PowerShell\/([\d.]+)/.exec(ua);
  if (ps) return `PowerShell ${ps[1] ?? ''}`.trim();
  if (/^Mozilla\//.test(ua)) return describeUserAgent(ua);
  const first = /^([^/\s]+)(?:\/([^\s]+))?/.exec(ua);
  if (!first) return ua;
  const [, product = '', version] = first;
  const name = CLI_NAMES.find(([re]) => re.test(product))?.[1] ?? product;
  return version ? `${name} ${version}` : name;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff < 0 ? 'just now' : 'in a moment';
}

/**
 * For things that already happened. A computer whose clock runs a little behind
 * agentbox's would otherwise see "in 10 minutes".
 */
export function agoTime(iso: string, now = Date.now()): string {
  return new Date(iso).getTime() > now ? 'just now' : relativeTime(iso, now);
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function suggestDeviceName(): string {
  const label = describeUserAgent(navigator.userAgent);
  return label.startsWith('Browser') ? 'My device' : label;
}
