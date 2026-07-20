export type TenantStatus = "ACTIVE" | "DELETED" | "DELETING" | "SUSPENDED";

export type PrincipalLookup = {
  issuer: string;
  subject: string;
};

export type PrincipalRecord = {
  principalId: string;
  status: TenantStatus;
  tenantId: string;
};

export interface PrincipalDirectory {
  resolve(lookup: PrincipalLookup): Promise<PrincipalRecord | null>;
}
