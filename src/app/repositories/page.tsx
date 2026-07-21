import { randomUUID } from "node:crypto";

import { GitBranch, Link2, LockKeyhole, LogIn, Play, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";

import { getWebSessionState } from "@/auth/auth0-client";
import type { WebIdentity } from "@/auth/web-session";
import { listWebRepositories } from "@/github/default-services";
import { reportGitHubRuntimeFailure } from "@/github/runtime-observability";

export const dynamic = "force-dynamic";

async function loadRepositoryPage(identity: WebIdentity) {
  try {
    return await listWebRepositories(identity);
  } catch (error) {
    reportGitHubRuntimeFailure("list-repositories", error);
    return null;
  }
}

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams?: Promise<{ github?: string; start?: string }>;
}) {
  await connection();
  const query = (await searchParams) ?? {};
  const session = await getWebSessionState();
  const repositoryPage =
    session.status === "signed_in"
      ? await loadRepositoryPage(session.identity)
      : null;

  return (
    <main className="account-shell">
      <nav className="account-nav" aria-label="Product navigation">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">RF</span>
          ReproForge
        </Link>
        <div className="account-nav-links">
          <Link className="account-back" href="/account">Data controls</Link>
          <Link className="account-back" href="/">Trusted sample</Link>
        </div>
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
              <>
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
                <form
                  action="/api/repositories/reproductions"
                  className="repository-start-form"
                  method="post"
                >
                  <input
                    name="idempotencyKey"
                    type="hidden"
                    value={`web-${randomUUID()}`}
                  />
                  <div className="repository-form-heading">
                    <div>
                      <p className="account-label">New deterministic run</p>
                      <h2>Define the exact failure contract</h2>
                    </div>
                    <span>Node + npm</span>
                  </div>
                  {query.start === "invalid" ? (
                    <p className="repository-form-error" role="alert">
                      Check the revision, scripts, and failure signature, then try again.
                    </p>
                  ) : query.start === "unavailable" ? (
                    <p className="repository-form-error" role="alert">
                      Repository execution is temporarily unavailable. No work was started.
                    </p>
                  ) : null}
                  <div className="repository-form-grid">
                    <label>
                      Authorized repository
                      <select name="repositoryId" required>
                        {repositoryPage.repositories.map((repository) => (
                          <option
                            key={repository.repositoryId}
                            value={repository.repositoryId}
                          >
                            {repository.fullName} · {repository.private ? "private" : "public"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Immutable commit SHA
                      <input
                        autoComplete="off"
                        inputMode="text"
                        maxLength={40}
                        minLength={40}
                        name="commitSha"
                        pattern="[a-f0-9]{40}"
                        placeholder="40 lowercase hexadecimal characters"
                        required
                      />
                    </label>
                    <label>
                      Issue number
                      <input min={1} name="issueNumber" type="number" />
                    </label>
                    <label>
                      Issue title
                      <input maxLength={256} name="issueTitle" />
                    </label>
                    <label>
                      Reproduction npm script
                      <input defaultValue="test:reproduce" maxLength={128} name="reproductionScript" required />
                    </label>
                    <label>
                      Negative-control npm script
                      <input defaultValue="test:control" maxLength={128} name="controlScript" required />
                    </label>
                    <label>
                      Node profile
                      <select defaultValue="24" name="nodeVersion">
                        <option value="24">Node 24</option>
                        <option value="22">Node 22</option>
                      </select>
                    </label>
                    <label>
                      Expected failure exit code
                      <input defaultValue="1" max={255} min={-255} name="expectedExitCode" required type="number" />
                    </label>
                    <label>
                      Failure output stream
                      <select defaultValue="stderr" name="failureStream">
                        <option value="stderr">stderr</option>
                        <option value="stdout">stdout</option>
                      </select>
                    </label>
                    <label className="repository-signature-field">
                      Exact failure signature
                      <input
                        maxLength={256}
                        name="failureOutput"
                        placeholder="A stable string that only the failing run emits"
                        required
                      />
                    </label>
                  </div>
                  <div className="repository-form-footer">
                    <p>
                      Script fields are allowlisted <code>package.json</code> names—not shell commands.
                      ReproForge runs one control and three clean candidates in fresh deny-all sandboxes.
                    </p>
                    <button className="primary-button" type="submit">
                      <Play size={17} aria-hidden="true" />
                      Start reproduction
                    </button>
                  </div>
                </form>
              </>
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
                Continue with GitHub
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
