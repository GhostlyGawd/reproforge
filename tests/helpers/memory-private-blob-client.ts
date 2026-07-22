import { createHash } from "node:crypto";

import type {
  PrivateBlobClient,
  PrivateBlobMetadata,
} from "@/infrastructure/artifacts/private-blob-client";

export class MemoryPrivateBlobClient implements PrivateBlobClient {
  readonly deletes: Array<{ etag?: string; pathname: string }> = [];
  readonly gets: string[] = [];
  readonly puts: string[] = [];
  reportedSizeDelta = 0;
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; metadata: PrivateBlobMetadata }
  >();

  async put(pathname: string, bytes: Uint8Array): Promise<PrivateBlobMetadata> {
    this.puts.push(pathname);
    if (this.objects.has(pathname)) throw new Error("BLOB_ALREADY_EXISTS");
    const etag = createHash("sha256").update(bytes).digest("hex");
    const metadata = {
      etag,
      pathname,
      size: bytes.byteLength + this.reportedSizeDelta,
    };
    this.objects.set(pathname, { bytes: Uint8Array.from(bytes), metadata });
    return metadata;
  }

  async head(pathname: string): Promise<PrivateBlobMetadata | null> {
    return this.objects.get(pathname)?.metadata ?? null;
  }

  async get(
    pathname: string,
    trustedSize: number,
  ): Promise<{ bytes: Uint8Array; metadata: PrivateBlobMetadata } | null> {
    void trustedSize;
    this.gets.push(pathname);
    const stored = this.objects.get(pathname);
    return stored
      ? { bytes: Uint8Array.from(stored.bytes), metadata: stored.metadata }
      : null;
  }

  async delete(pathname: string, etag?: string): Promise<boolean> {
    this.deletes.push({ etag, pathname });
    const stored = this.objects.get(pathname);
    if (!stored || (etag !== undefined && etag !== stored.metadata.etag)) {
      return false;
    }
    return this.objects.delete(pathname);
  }

  has(pathname: string): boolean {
    return this.objects.has(pathname);
  }

  tamper(pathname: string, bytes: Uint8Array): void {
    const stored = this.objects.get(pathname);
    if (!stored) throw new Error("missing test blob");
    stored.bytes = Uint8Array.from(bytes);
  }
}
