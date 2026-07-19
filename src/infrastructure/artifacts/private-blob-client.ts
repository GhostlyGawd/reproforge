export type PrivateBlobMetadata = Readonly<{
  etag: string;
  pathname: string;
  size: number;
}>;

export interface PrivateBlobClient {
  put(pathname: string, bytes: Uint8Array): Promise<PrivateBlobMetadata>;
  head(pathname: string): Promise<PrivateBlobMetadata | null>;
  get(
    pathname: string,
  ): Promise<{ bytes: Uint8Array; metadata: PrivateBlobMetadata } | null>;
  delete(pathname: string, etag?: string): Promise<boolean>;
}
