import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from "jose";

const DEFAULT_NOW_SECONDS = 1_800_000_000;

export type OAuthIssuerFixture = Awaited<
  ReturnType<typeof createOAuthIssuerFixture>
>;

export async function createOAuthIssuerFixture(options?: {
  audience?: string;
  issuer?: string;
  nowSeconds?: number;
}) {
  const issuer = options?.issuer ?? "https://issuer.reproforge.test/";
  const audience = options?.audience ?? "https://reproforge.test/mcp";
  const nowSeconds = options?.nowSeconds ?? DEFAULT_NOW_SECONDS;
  const keyId = "reproforge-test-key-1";
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const { privateKey: unsupportedPrivateKey } = await generateKeyPair("PS256");
  const publicJwk = await exportJWK(publicKey);
  const discoveryUrl = new URL(
    ".well-known/openid-configuration",
    issuer,
  ).toString();
  const jwksUrl = new URL(".well-known/jwks.json", issuer).toString();
  const requests: string[] = [];

  const fetcher: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push(url);
    if (url === discoveryUrl) {
      return Response.json({
        authorization_endpoint: new URL("authorize", issuer).toString(),
        code_challenge_methods_supported: ["S256"],
        issuer,
        jwks_uri: jwksUrl,
        response_types_supported: ["code"],
        token_endpoint: new URL("oauth/token", issuer).toString(),
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url === jwksUrl) {
      return Response.json({
        keys: [
          {
            ...publicJwk,
            alg: "RS256",
            kid: keyId,
            use: "sig",
          },
        ],
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  async function sign(
    overrides: JWTPayload & {
      algorithm?: string;
      keyId?: string;
    } = {},
  ): Promise<string> {
    const {
      algorithm = "RS256",
      keyId: tokenKeyId = keyId,
      ...claims
    } = overrides;
    return new SignJWT({
      "https://reproforge.dev/tenant_id": "tenant-alpha",
      scope:
        "reproforge:cases:read reproforge:repositories:read",
      ...claims,
    })
      .setProtectedHeader({ alg: algorithm, kid: tokenKeyId, typ: "JWT" })
      .setIssuer(claims.iss ?? issuer)
      .setSubject(claims.sub ?? "auth0|principal-alpha")
      .setAudience(claims.aud ?? audience)
      .setIssuedAt(claims.iat ?? nowSeconds - 10)
      .setNotBefore(claims.nbf ?? nowSeconds - 10)
      .setExpirationTime(claims.exp ?? nowSeconds + 300)
      .sign(privateKey);
  }

  async function signUnsupportedAlgorithm(): Promise<string> {
    return new SignJWT({
      "https://reproforge.dev/tenant_id": "tenant-alpha",
      scope: "reproforge:cases:read",
    })
      .setProtectedHeader({ alg: "PS256", kid: "unsupported-key", typ: "JWT" })
      .setIssuer(issuer)
      .setSubject("auth0|principal-alpha")
      .setAudience(audience)
      .setIssuedAt(nowSeconds - 10)
      .setNotBefore(nowSeconds - 10)
      .setExpirationTime(nowSeconds + 300)
      .sign(unsupportedPrivateKey);
  }

  return {
    audience,
    discoveryUrl,
    fetcher,
    issuer,
    jwksUrl,
    nowSeconds,
    requests,
    sign,
    signUnsupportedAlgorithm,
  };
}
