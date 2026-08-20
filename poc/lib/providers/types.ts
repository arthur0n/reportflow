/**
 * §6 — the canonical AI job. Provider-agnostic BY CONSTRUCTION.
 *
 * In the real system the API emits exactly this and never imports an AI SDK or
 * sees a key; the relay holds one adapter per provider under
 * `relay/src/providers/`, each mapping this payload in and `{ content, usage,
 * model, provider }` out. Adding a provider = one file + one registry line.
 *
 * This POC has already had to survive one provider swap (Anthropic -> Gemini)
 * mid-build. It cost exactly this directory: `extract.ts`, `analyse.ts`,
 * `render.ts`, the field lists, the templates and the money code were all
 * untouched. That is the decision earning its keep rather than being asserted.
 */

export interface AiJob {
  readonly system: string;
  readonly prompt: string;
  /** Absent for hop 2 — §12.3: analysis reads extraction JSON, never the PDF. */
  readonly documentPath?: string;
  /**
   * Provider-neutral JSON Schema, derived from the frozen field list.
   * Each adapter translates it into its own dialect; the field list stays the
   * single source of truth.
   */
  readonly schema: Record<string, unknown>;
  readonly schemaName: string;
  readonly maxTokens: number;
}

/** Canonical usage — this is what makes `costFor()` work across providers. */
export interface AiUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface AiResult {
  /** Raw text. NOT parsed here: a model's JSON is untrusted input (§12.4). */
  readonly text: string;
  readonly usage: AiUsage;
  readonly model: string;
  readonly provider: string;
}

export interface AiAdapter {
  readonly provider: string;
  readonly send: (job: AiJob, model: string) => Promise<AiResult>;
}

export class PermanentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
