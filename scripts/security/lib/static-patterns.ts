/**
 * Matches actual HTML/JSX embedded browsing or plugin contexts. The delimiter
 * check is intentional: `<object,` can occur in safe TypeScript generic
 * syntax and must not be treated as an element.
 */
export const EMBEDDED_CONTEXT_PATTERN = /(?:<\s*(?:iframe|object|embed)(?=[\s/>])|\bsrcDoc\s*=)/iu
