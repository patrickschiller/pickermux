export const MAX_PROVIDER_ID_LENGTH = 127;

export const PROVIDER_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9_-]{0,125}[a-z0-9])?$/u;

export function isValidProviderId(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(value)
  );
}
