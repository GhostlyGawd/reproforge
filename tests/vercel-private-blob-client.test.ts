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
    await expect(client.get(pathname)).resolves.toEqual({
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
});
