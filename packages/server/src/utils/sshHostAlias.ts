/**
 * Conservative validator for SSH host aliases / host-like tokens.
 *
 * Allows:
 * - letters and numbers
 * - dots, underscores, and dashes after the first character
 *
 * Disallows:
 * - leading dash (prevents option-like values such as "-oProxyCommand=...")
 * - whitespace and shell metacharacters
 */
export const SSH_HOST_ALIAS_REGEX = /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Normalize raw host input from API payloads.
 */
export function normalizeSshHostAlias(host: string): string {
  return host.trim();
}

/**
 * True when the provided host token is a valid SSH alias/hostname-like value.
 */
export function isValidSshHostAlias(host: string): boolean {
  return SSH_HOST_ALIAS_REGEX.test(host);
}
