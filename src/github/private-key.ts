import { createPrivateKey, type KeyObject } from "node:crypto";

const supportedPemBoundaries = [
  ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"],
  ["-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"],
] as const;

export function parseGitHubAppPrivateKey(value: string): KeyObject {
  if (
    !supportedPemBoundaries.some(
      ([begin, end]) => value.includes(begin) && value.includes(end),
    )
  ) {
    throw new TypeError("Unsupported GitHub App private-key format");
  }
  const key = createPrivateKey(value);
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
    throw new TypeError("GitHub App private key must use RSA");
  }
  return key;
}

export function isGitHubAppPrivateKey(value: string): boolean {
  try {
    parseGitHubAppPrivateKey(value);
    return true;
  } catch {
    return false;
  }
}
