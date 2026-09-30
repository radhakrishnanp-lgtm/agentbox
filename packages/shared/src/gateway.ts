/**
 * Key gateway: AI keys stay on agentbox, and each machine gets a revocable
 * pass. The machine's CLIs talk to `<origin>/gw/<slug>/…`, and agentbox swaps
 * the pass for the real key on the way to the provider.
 */
import { z } from 'zod';
import { displayNameSchema } from './schemas.ts';

/** How the real key is attached to the upstream request. */
export type KeyAuthStyle =
  | 'x-api-key'
  | 'bearer'
  | 'x-goog-api-key'
  | 'anthropic-oauth'
  /** No stored key: the Grok login in the terminal vault hands out short-lived tokens. */
  | 'grok-login';

export const KEY_AUTH_STYLES = [
  'x-api-key',
  'bearer',
  'x-goog-api-key',
  'anthropic-oauth',
  'grok-login',
] as const satisfies readonly KeyAuthStyle[];

/** The CLIs agentbox can wire up on a machine. */
export const GATEWAY_CLIS = ['claude', 'codex', 'grok', 'kimi', 'gemini'] as const;
export type GatewayCli = (typeof GATEWAY_CLIS)[number];

export interface ProviderPreset {
  id: string;
  label: string;
  upstream: string;
  auth: KeyAuthStyle;
  cli: GatewayCli | null;
  /** Default slug, which becomes part of the gateway URL. */
  slug: string;
  /** Where the owner finds the key. */
  help: string;
  /** Works in principle but has not been confirmed against the real provider. */
  experimental?: boolean;
  /** The CLI can't pick a model for this provider by itself, so the key must name one. */
  needsModel?: boolean;
  /** Shown as a warning when the preset is picked. */
  note?: string;
  /** Nothing to paste: the login comes from somewhere else on agentbox. */
  noSecret?: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic API key (Claude Code)',
    upstream: 'https://api.anthropic.com',
    auth: 'x-api-key',
    cli: 'claude',
    slug: 'anthropic',
    help: 'console.anthropic.com → API keys. Starts with sk-ant-api.',
  },
  {
    id: 'anthropic-subscription',
    label: 'Claude Pro/Max subscription token (Claude Code)',
    upstream: 'https://api.anthropic.com',
    auth: 'anthropic-oauth',
    cli: 'claude',
    slug: 'claude',
    help: 'Run `claude setup-token` on a trusted computer and paste the token. Starts with sk-ant-oat.',
    experimental: true,
    note: "Claude Code accepts this token for headless use. Routing it through agentbox has not been checked against Anthropic's live service yet, and Anthropic may limit how subscription tokens are used. An Anthropic API key is the reliable option.",
  },
  {
    id: 'openai',
    label: 'OpenAI API key (Codex)',
    upstream: 'https://api.openai.com',
    auth: 'bearer',
    cli: 'codex',
    slug: 'openai',
    help: 'platform.openai.com → API keys. Starts with sk-.',
  },
  {
    id: 'xai',
    label: 'xAI API key (Grok)',
    upstream: 'https://api.x.ai',
    auth: 'bearer',
    cli: 'grok',
    slug: 'xai',
    help: 'console.x.ai → API keys. Starts with xai-.',
  },
  {
    id: 'grok-login',
    label: 'SuperGrok login from your Terminals (Grok)',
    upstream: 'https://auth.x.ai',
    auth: 'grok-login',
    cli: 'grok',
    slug: 'supergrok',
    help: 'Sign in to Grok once in a terminal on this server (run grok, or grok login). Nothing to paste here.',
    experimental: true,
    noSecret: true,
    note: 'Machines get short-lived Grok tokens from the login in your vault, so the vault must be unlocked. The long-lived login never leaves this server. Stopping a machine stops new tokens; a token it already has keeps working until it expires, usually within an hour. Not yet checked against the live Grok service.',
  },
  {
    id: 'moonshot',
    label: 'Moonshot API key (Kimi)',
    upstream: 'https://api.moonshot.ai',
    auth: 'bearer',
    cli: 'kimi',
    slug: 'kimi',
    help: 'platform.moonshot.ai → API keys. For China accounts, change the address to https://api.moonshot.cn.',
    needsModel: true,
  },
  {
    id: 'moonshot-anthropic',
    label: 'Moonshot API key, used from Claude Code (Kimi models)',
    upstream: 'https://api.moonshot.ai/anthropic',
    auth: 'bearer',
    cli: 'claude',
    slug: 'kimi-claude',
    help: 'The same Moonshot key, through Moonshot’s Claude-compatible address.',
    needsModel: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini API key (Gemini CLI)',
    upstream: 'https://generativelanguage.googleapis.com',
    auth: 'x-goog-api-key',
    cli: 'gemini',
    slug: 'gemini',
    help: 'aistudio.google.com → Get API key.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter API key (any OpenAI-compatible tool)',
    upstream: 'https://openrouter.ai/api',
    auth: 'bearer',
    cli: null,
    slug: 'openrouter',
    help: 'openrouter.ai → Keys.',
  },
  {
    id: 'custom',
    label: 'Other provider',
    upstream: '',
    auth: 'bearer',
    cli: null,
    slug: 'custom',
    help: 'Any HTTPS API that takes a key in a header.',
  },
];

export const GATEWAY_LIMITS = {
  keyNameMax: 40,
  machineNameMax: 40,
  secretMax: 4096,
  ipRulesMax: 16,
  rpmDefault: 60,
  rpmMax: 600,
  dailyTokensMax: 1_000_000_000,
  /** Pass lifetimes the owner can pick, in days (null = until revoked). */
  lifetimesDays: [7, 30, 90, 365] as const,
  lifetimeDefaultDays: 30,
} as const;

/** Machine passes look like abx_<43 base64url chars>. */
export const PASS_PREFIX = 'abx_';
export const passSchema = z.string().regex(/^abx_[A-Za-z0-9_-]{43}$/);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'Use 2–31 lowercase letters, digits or dashes');

const ipRuleSchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

export const aiKeyCreateSchema = z.object({
  preset: z.string().min(1).max(40),
  name: displayNameSchema(GATEWAY_LIMITS.keyNameMax),
  slug: slugSchema,
  /** Empty for presets with noSecret. */
  secret: z.string().trim().max(GATEWAY_LIMITS.secretMax).default(''),
  /** Overrides the preset's address (required for "custom"). */
  upstream: z.string().trim().max(300).optional(),
  auth: z.enum(KEY_AUTH_STYLES).optional(),
  cli: z.enum(GATEWAY_CLIS).nullable().optional(),
  /** Default model for the machine's CLI, e.g. a Kimi model name. */
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:/-]{1,100}$/, 'Use the model name exactly as the provider writes it')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type AiKeyCreate = z.infer<typeof aiKeyCreateSchema>;

const machineFields = {
  name: displayNameSchema(GATEWAY_LIMITS.machineNameMax),
  keyIds: z.array(z.uuid()).min(1, 'Pick at least one key').max(20),
  ipRules: z.array(ipRuleSchema).max(GATEWAY_LIMITS.ipRulesMax),
  rpm: z.number().int().min(1).max(GATEWAY_LIMITS.rpmMax),
  dailyTokenLimit: z.number().int().min(1000).max(GATEWAY_LIMITS.dailyTokensMax).nullable(),
  /**
   * Locks the pass to the first address that uses it. Any other address is
   * refused until you allow it in agentbox, so a copied pass is useless elsewhere.
   */
  approveNewIps: z.boolean(),
};
const lifetimeSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(365),
  z.null(),
]);

export const machineCreateSchema = z.object({
  ...machineFields,
  ipRules: machineFields.ipRules.default([]),
  rpm: machineFields.rpm.default(GATEWAY_LIMITS.rpmDefault),
  approveNewIps: machineFields.approveNewIps.default(true),
  lifetimeDays: lifetimeSchema.default(GATEWAY_LIMITS.lifetimeDefaultDays),
});
export type MachineCreate = z.input<typeof machineCreateSchema>;

/** No defaults here: a field left out stays as it is (renewing must not clear the IP lock). */
export const machineUpdateSchema = z.object(machineFields).partial().extend({
  /** Extends the pass from now by this many days (null = until revoked). */
  renewDays: lifetimeSchema.optional(),
});
export type MachineUpdate = z.input<typeof machineUpdateSchema>;

export interface AiKeySummary {
  id: string;
  name: string;
  slug: string;
  preset: string;
  upstream: string;
  auth: KeyAuthStyle;
  cli: GatewayCli | null;
  model: string | null;
  /** Last 4 characters only, so you can tell keys apart. */
  hint: string;
  gatewayUrl: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MachineSummary {
  id: string;
  name: string;
  /** First characters of the pass, to match it with what is on the machine. */
  passPrefix: string;
  keyIds: string[];
  ipRules: string[];
  rpm: number;
  dailyTokenLimit: number | null;
  createdAt: string;
  expiresAt: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  revokedAt: string | null;
  approveNewIps: boolean;
  /** The latest address that was refused and waits for you to allow it. */
  pendingIp: string | null;
  pendingIpAt: string | null;
  today: { requests: number; inputTokens: number; outputTokens: number };
}

export interface MachineCreated {
  machine: MachineSummary;
  /** Shown once. agentbox keeps only its hash. */
  pass: string;
  /** Paste on the machine; it asks for the pass. */
  installCommand: string;
}

export interface GatewayOverview {
  keys: AiKeySummary[];
  machines: MachineSummary[];
  presets: readonly ProviderPreset[];
}

export interface GatewayUsageRow {
  id: string;
  ts: string;
  machineId: string;
  keySlug: string;
  method: string;
  path: string;
  model: string | null;
  status: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}
