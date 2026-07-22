import { Buffer } from "node:buffer";

import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  del,
  get,
  head,
  put,
} from "@vercel/blob";

import type {
  PrivateBlobClient,
  PrivateBlobMetadata,
} from "./private-blob-client";

export type VercelBlobAuthentication =
  | Readonly<{ method: "oidc"; oidcToken: string; storeId: string }>
  | Readonly<{ method: "read-write-token"; token: string }>;

export type VercelBlobOperations = Readonly<{
  del: typeof del;
  get: typeof get;
  head: typeof head;
  put: typeof put;
}>;

export class PrivateBlobConfigurationError extends Error {
  readonly code = "INVALID_PRIVATE_BLOB_CONFIGURATION";

  constructor() {
    super("The private Blob configuration is invalid");
    this.name = "PrivateBlobConfigurationError";
  }
}

const MAX_PRIVATE_BLOB_BYTES = 1_073_741_824;

function validateTrustedSize(trustedSize: number): number {
  if (
    !Number.isSafeInteger(trustedSize) ||
    trustedSize < 0 ||
    trustedSize > MAX_PRIVATE_BLOB_BYTES
  ) {
    throw new Error("Private Blob trusted size is invalid");
  }
  return trustedSize;
}

function canonicalEtag(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function validateAuthentication(
  authentication: VercelBlobAuthentication,
): VercelBlobAuthentication {
  const valid =
    authentication.method === "oidc"
      ? authentication.oidcToken.length > 0 && authentication.storeId.length > 0
      : authentication.token.length > 0;
  if (!valid) throw new PrivateBlobConfigurationError();
  return authentication;
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  trustedSize: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteCount += result.value.byteLength;
    if (byteCount > trustedSize) {
      await reader.cancel();
      throw new Error("Private Blob stream exceeded its trusted size");
    }
    chunks.push(result.value);
  }
  if (byteCount !== trustedSize) {
    throw new Error("Private Blob stream did not match its trusted size");
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class VercelPrivateBlobClient implements PrivateBlobClient {
  private readonly authentication: VercelBlobAuthentication;

  constructor(
    authentication: VercelBlobAuthentication,
    private readonly operations: VercelBlobOperations = { del, get, head, put },
  ) {
    this.authentication = validateAuthentication(authentication);
  }

  async put(
    pathname: string,
    bytes: Uint8Array,
  ): Promise<PrivateBlobMetadata> {
    await this.operations.put(pathname, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/octet-stream",
      ...this.credentials(),
    });
    const metadata = await this.head(pathname);
    if (!metadata) throw new Error("Private Blob metadata was unavailable");
    return metadata;
  }

  async head(pathname: string): Promise<PrivateBlobMetadata | null> {
    try {
      const metadata = await this.operations.head(pathname, this.credentials());
      return {
        etag: canonicalEtag(metadata.etag),
        pathname: metadata.pathname,
        size: metadata.size,
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }

  async get(
    pathname: string,
    rawTrustedSize: number,
  ): Promise<{ bytes: Uint8Array; metadata: PrivateBlobMetadata } | null> {
    const trustedSize = validateTrustedSize(rawTrustedSize);
    const result = await this.operations.get(pathname, {
      access: "private",
      useCache: false,
      ...this.credentials(),
    });
    if (!result) return null;
    if (
      result.statusCode !== 200 ||
      !result.stream ||
      result.blob.size === null
    ) {
      throw new Error("Private Blob returned an invalid body");
    }
    const bytes = await collectStream(result.stream, trustedSize);
    const metadata = await this.head(pathname);
    if (
      !metadata ||
      metadata.pathname !== result.blob.pathname ||
      metadata.size !== trustedSize
    ) {
      throw new Error("Private Blob metadata did not match the trusted object");
    }
    return {
      bytes,
      metadata,
    };
  }

  async delete(pathname: string, etag?: string): Promise<boolean> {
    try {
      await this.operations.del(pathname, {
        ...(etag ? { ifMatch: etag } : {}),
        ...this.credentials(),
      });
      return true;
    } catch (error) {
      if (
        error instanceof BlobNotFoundError ||
        error instanceof BlobPreconditionFailedError
      ) {
        return false;
      }
      throw error;
    }
  }

  private credentials():
    | { oidcToken: string; storeId: string }
    | { token: string } {
    return this.authentication.method === "oidc"
      ? {
          oidcToken: this.authentication.oidcToken,
          storeId: this.authentication.storeId,
        }
      : { token: this.authentication.token };
  }
}
