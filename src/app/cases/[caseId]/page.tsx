import { ArrowLeft, GitBranch, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";

import { toReproductionProgress } from "@/application/progress";
import { getWebSessionState } from "@/auth/auth0-client";
import { DurableProgressPanel } from "@/components/durable-progress-panel";
import { getWebRepositoryCase } from "@/github/default-services";

export const dynamic = "force-dynamic";

export default async function CasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  await connection();
  const { caseId } = await params;
  const session = await getWebSessionState();
  const snapshot =
    session.status === "signed_in"
      ? await getWebRepositoryCase(session.identity, caseId).catch(() => null)
      : null;

  return (
    <main className="account-shell">
      <nav className="account-nav" aria-label="Product navigation">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">RF</span>
          ReproForge
        </Link>
        <Link className="account-back" href="/repositories">
          <ArrowLeft size={15} aria-hidden="true" />
          Repositories
        </Link>
      </nav>

      <section className="account-panel" aria-labelledby="case-heading">
        <div className="account-eyebrow">
          <LockKeyhole size={16} aria-hidden="true" />
          Tenant-scoped durable case
        </div>
        <h1 id="case-heading">Reproduction progress</h1>
        <p className="account-lede">
          This page reads the same durable snapshot returned to ChatGPT and the
          REST API. It never infers completion from animation or elapsed time.
        </p>

        {session.status !== "signed_in" ? (
          <div className="account-card account-card-signed-out">
            <div>
              <p className="account-label">
                {session.status === "unconfigured"
                  ? "Identity provider setup pending"
                  : "Account linking required"}
              </p>
              <p className="account-name">
                {session.status === "unconfigured"
                  ? "The case view is unavailable until identity is configured."
                  : "Sign in to read this case."}
              </p>
            </div>
            {session.status === "signed_out" ? (
              <a className="primary-button" href={`/auth/login?returnTo=/cases/${encodeURIComponent(caseId)}`}>
                Continue with GitHub
              </a>
            ) : null}
          </div>
        ) : snapshot === null ? (
          <div className="account-card account-card-signed-out" role="status">
            <div>
              <p className="account-label">Case unavailable</p>
              <p className="account-name">
                This identifier is not available to the signed-in tenant.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="case-identity">
              <div>
                <p className="account-label">Case</p>
                <code>{snapshot.case.id}</code>
              </div>
              <div>
                <p className="account-label">Job</p>
                <code>{snapshot.job.id}</code>
              </div>
            </div>
            <DurableProgressPanel
              progress={toReproductionProgress(snapshot.job)}
            />
            {snapshot.repositorySource ? (
              <section className="case-source" aria-labelledby="case-source-heading">
                <GitBranch size={18} aria-hidden="true" />
                <div>
                  <p className="account-label" id="case-source-heading">Immutable source</p>
                  <strong>{snapshot.repositorySource.fullName}</strong>
                  <code>{snapshot.repositorySource.commitSha}</code>
                  <span>{snapshot.repositorySource.private ? "Private repository" : "Public repository"}</span>
                </div>
              </section>
            ) : null}
            {snapshot.result ? (
              <section className="case-result" aria-labelledby="case-result-heading">
                <p className="account-label">Machine result</p>
                <h2 id="case-result-heading">{snapshot.result.summary.status}</h2>
                <p>{snapshot.result.summary.reason}</p>
                {snapshot.result.bundle ? (
                  <code>SHA-256 {snapshot.result.bundle.bundleHash}</code>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
