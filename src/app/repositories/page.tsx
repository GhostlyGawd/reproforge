import { GitBranch, Link2, LockKeyhole, LogIn, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";

import { getWebSessionState } from "@/auth/auth0-client";
import { listWebRepositories } from "@/github/default-services";

export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  await connection();
  const session = await getWebSessionState();
  const repositoryPage =
    session.status === "signed_in"
      ? await listWebRepositories(session.identity).catch(() => null)
      : null;

  return (
    <main className="account-shell">
      <nav className="account-nav" aria-label="Product navigation">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">RF</span>
          ReproForge
        </Link>
        <Link className="account-back" href="/">Trusted sample</Link>
      </nav>

      <section className="account-panel" aria-labelledby="repository-heading">
        <div className="account-eyebrow">
          <ShieldCheck size={16} aria-hidden="true" />
          Read-only repository authorization
        </div>
        <h1 id="repository-heading">Connect the code you want to reproduce.</h1>
        <p className="account-lede">
          ReproForge uses your account only to establish a tenant. GitHub access
          stays in a separate read-only App installation and is checked again for
          every immutable revision.
        </p>

        {session.status === "signed_in" ? (
          <>
          <div className="account-card" data-session-state="signed-in">
            <div>
              <p className="account-label">Signed in as</p>
              <p className="account-name">{session.account.displayName}</p>
              {session.account.email ? (
                <p className="account-email">{session.account.email}</p>
              ) : null}
            </div>
            <div className="account-actions">
              <a className="primary-button" href="/api/github/install">
                <GitBranch size={17} aria-hidden="true" />
                Connect GitHub App
              </a>
              <a className="secondary-button" href="/auth/logout">
                Sign out
              </a>
            </div>
          </div>
          <section className="repository-catalog" aria-labelledby="connected-heading">
            <div className="repository-catalog-heading">
              <div>
                <p className="account-label">Installation selection</p>
                <h2 id="connected-heading">Authorized repositories</h2>
              </div>
              <span className="repository-count">
                {repositoryPage?.repositories.length ?? 0} connected
              </span>
            </div>
            {repositoryPage === null ? (
              <p className="repository-empty">
                GitHub authorization is not configured for this environment yet.
              </p>
            ) : repositoryPage.repositories.length === 0 ? (
              <p className="repository-empty">
                Connect the GitHub App, then select the repositories ReproForge may read.
              </p>
            ) : (
              <ul className="repository-list">
                {repositoryPage.repositories.map((repository) => (
                  <li key={repository.repositoryId}>
                    <div>
                      <strong>{repository.fullName}</strong>
                      <span>Default branch: {repository.defaultBranch}</span>
                    </div>
                    <span className="repository-visibility">
                      {repository.private ? "Private" : "Public"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          </>
        ) : (
          <div
            className="account-card account-card-signed-out"
            data-session-state={session.status}
          >
            <div>
              <p className="account-label">
                {session.status === "unconfigured"
                  ? "Identity provider setup pending"
                  : "Account linking required"}
              </p>
              <p className="account-name">
                {session.status === "unconfigured"
                  ? "The trusted sample remains available."
                  : "Sign in before connecting a repository."}
              </p>
            </div>
            {session.status === "signed_out" ? (
              <a className="primary-button" href="/auth/login?returnTo=/repositories">
                <LogIn size={17} aria-hidden="true" />
                Sign in with Auth0
              </a>
            ) : (
              <Link className="secondary-button" href="/">
                Run trusted sample
              </Link>
            )}
          </div>
        )}

        <div className="authorization-grid" aria-label="Authorization boundaries">
          <article>
            <LockKeyhole size={18} aria-hidden="true" />
            <h2>Server-side session</h2>
            <p>Encrypted, HttpOnly, SameSite cookies. No access token is placed in local or session storage.</p>
          </article>
          <article>
            <GitBranch size={18} aria-hidden="true" />
            <h2>Read-only GitHub App</h2>
            <p>Repository metadata and contents only; issue read access is used only for issue ingestion.</p>
          </article>
          <article>
            <Link2 size={18} aria-hidden="true" />
            <h2>Immutable source</h2>
            <p>Every run pins a full commit SHA and rechecks installation authorization before acquisition.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
