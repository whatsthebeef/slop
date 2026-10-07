import type { KbItem } from './kb.js';
import type { Glob, Status } from './types.js';

export type DomainError =
  | { readonly code: 'forbidden'; readonly message: string }
  | { readonly code: 'not_found'; readonly message: string }
  | { readonly code: 'version_conflict'; readonly message: string; readonly current: Glob }
  /** A KB item changed since it was read (another admin decided it). */
  | { readonly code: 'version_conflict'; readonly message: string; readonly currentItem: KbItem }
  | {
      readonly code: 'invalid_transition';
      readonly message: string;
      readonly status: Status;
      readonly allowedActions: readonly string[];
    }
  | { readonly code: 'invalid_combination'; readonly message: string }
  | { readonly code: 'invalid_input'; readonly message: string }
  | { readonly code: 'run_active'; readonly message: string }
  /** The LLM can't be reached for reasons outside the request (e.g. an expired AWS sign-in). */
  | { readonly code: 'llm_unavailable'; readonly message: string; readonly reason: string; readonly fix: string };

export type DomainErrorCode = DomainError['code'];

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (error: DomainError): Result<never> => ({ ok: false, error });

export const forbidden = (message: string): Result<never> => err({ code: 'forbidden', message });
export const notFound = (message: string): Result<never> => err({ code: 'not_found', message });
export const invalidInput = (message: string): Result<never> =>
  err({ code: 'invalid_input', message });
export const invalidCombination = (message: string): Result<never> =>
  err({ code: 'invalid_combination', message });
export const runActive = (message: string): Result<never> => err({ code: 'run_active', message });
export const llmUnavailable = (reason: string, fix: string): Result<never> =>
  err({ code: 'llm_unavailable', message: `AI unavailable: ${reason}. ${fix}`, reason, fix });
