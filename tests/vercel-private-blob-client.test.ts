import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  VercelPrivateBlobClient,
  type VercelBlobOperations,
} from "@/infrastructure/artifacts/vercel-private-blob-client";

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("Vercel private Blob client", () => {
  it("uses OIDC, private immutable writes, and cache-bypassed reads", async () => {
    const bytes = new TextEncoder().encode("private bundle");
    const pathname = "tenants/t/cases/c/bundle/" + "a".repeat(64);
    const providerBlob = {
      cacheControl: "public, max-age=60",
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: `https://store.private.blob.vercel-storage.com/${pathname}?download=1`,
      etag: "etag-private",
      pathname,
      size: bytes.byteLength,
      uploadedAt: new Date("2026-07-19T20:00:00.000Z"),
      url: `https://store.private.blob.vercel-storage.com/${pathname}`,
    };
    const operations = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => ({
        blob: providerBlob,
        headers: new Headers(),
        statusCode: 200,
        stream: stream(bytes),
      })),
      head: vi.fn(async () => providerBlob),
      put: vi.fn(async () => providerBlob),
    } as unknown as VercelBlobOperations;
    const client = new VercelPrivateBlobClient(
      {
        method: "oidc",
        oidcToken: "synthetic-rotating-token",
        storeId: "store_reproforge",
      },
      operations,
    );

    await expect(client.put(pathname, bytes)).resolves.toEqual({
      etag: "etag-private",
      pathname,
      size: bytes.byteLength,
    });
    await expect(client.get(pathname, bytes.byteLength)).resolves.toEqual({
      bytes,
      metadata: { etag: "etag-private", pathname, size: bytes.byteLength },
    });
    await client.delete(pathname, "etag-private");

    expect(operations.put).toHaveBeenCalledWith(pathname, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/octet-stream",
      oidcToken: "synthetic-rotating-token",
      storeId: "store_reproforge",
    });
    expect(operations.get).toHaveBeenCalledWith(pathname, {
      access: "private",
      oidcToken: "synthetic-rotating-token",
      storeId: "store_reproforge",
      useCache: false,
    });
    expect(operations.del).toHaveBeenCalledWith(pathname, {
      ifMatch: "etag-private",
      oidcToken: "synthetic-rotating-token",
      storeId: "store_reproforge",
    });
    expect(JSON.stringify(await client.head(pathname))).not.toContain(
      "blob.vercel-storage.com",
    );
  });

  it("bounds decoded bytes by the trusted object size instead of encoded Content-Length", async () => {
    const bytes = new TextEncoder().encode("a highly compressible private bundle".repeat(32));
    const pathname = "tenants/t/cases/c/bundle/" + "b".repeat(64);
    const providerBlob = {
      cacheControl: "private",
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: `https://store.private.blob.vercel-storage.com/${pathname}?download=1`,
      etag: '"etag-compressed"',
      pathname,
      size: 41,
      uploadedAt: new Date("2026-07-19T20:00:00.000Z"),
      url: `https://store.private.blob.vercel-storage.com/${pathname}`,
    };
    const providerMetadata = {
      ...providerBlob,
      etag: "etag-compressed",
      size: bytes.byteLength,
    };
    const operations = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => ({
        blob: providerBlob,
        headers: new Headers({
          "content-encoding": "br",
          "content-length": String(providerBlob.size),
        }),
        statusCode: 200,
        stream: stream(bytes),
      })),
      head: vi.fn(async () => providerMetadata),
      put: vi.fn(async () => providerBlob),
    } as unknown as VercelBlobOperations;
    const client = new VercelPrivateBlobClient(
      { method: "read-write-token", token: "synthetic-token" },
      operations,
    );

    await expect(client.get(pathname, bytes.byteLength)).resolves.toEqual({
      bytes,
      metadata: {
        etag: "etag-compressed",
        pathname,
        size: bytes.byteLength,
      },
    });
  });

  it("cancels a decoded stream that exceeds the trusted object size", async () => {
    const bytes = new TextEncoder().encode("oversized decoded body");
    const pathname = "tenants/t/cases/c/bundle/" + "c".repeat(64);
    const cancelled = vi.fn();
    const providerBlob = {
      cacheControl: "private",
      contentDisposition: "attachment",
      contentType: "application/octet-stream",
      downloadUrl: `https://store.private.blob.vercel-storage.com/${pathname}?download=1`,
      etag: "etag-oversized",
      pathname,
      size: 4,
      uploadedAt: new Date("2026-07-19T20:00:00.000Z"),
      url: `https://store.private.blob.vercel-storage.com/${pathname}`,
    };
    const operations = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => ({
        blob: providerBlob,
        headers: new Headers(),
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          cancel: cancelled,
          start(controller) {
            controller.enqueue(bytes);
          },
        }),
      })),
      head: vi.fn(async () => providerBlob),
      put: vi.fn(async () => providerBlob),
    } as unknown as VercelBlobOperations;
    const client = new VercelPrivateBlobClient(
      { method: "read-write-token", token: "synthetic-token" },
      operations,
    );

    await expect(client.get(pathname, 4)).rejects.toThrow(
      "Private Blob stream exceeded its trusted size",
    );
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects an unsafe trusted size before reading from the provider", async () => {
    const operations = {
      del: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      put: vi.fn(),
    } as unknown as VercelBlobOperations;
    const client = new VercelPrivateBlobClient(
      { method: "read-write-token", token: "synthetic-token" },
      operations,
    );

    await expect(client.get("private/object", -1)).rejects.toThrow(
      "Private Blob trusted size is invalid",
    );
    await expect(
      client.get("private/object", 1_073_741_825),
    ).rejects.toThrow("Private Blob trusted size is invalid");
    expect(operations.get).not.toHaveBeenCalled();
  });
});
