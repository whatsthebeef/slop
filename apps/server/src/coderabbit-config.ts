import { codeReview } from '@slop/core';
import { parse } from 'yaml';

/** Where CodeRabbit reads a repo's settings from, in the order it looks. */
export const CODERABBIT_CONFIG_FILES = ['.coderabbit.yaml', '.coderabbit.yml'] as const;

/**
 * Whether a `.coderabbit.yaml` turns CodeRabbit's automatic reviews off. A file that doesn't parse leaves them on, so
 * slop posts nothing (the safe default: CodeRabbit is then either reviewing on its own or misconfigured).
 */
export const autoReviewDisabled = (text: string): boolean => {
  let config: unknown;
  try {
    config = parse(text);
  } catch {
    return false;
  }
  return codeReview.autoReviewOff(config);
};
