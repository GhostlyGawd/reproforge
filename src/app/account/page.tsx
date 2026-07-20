import {
  Archive,
  ArrowLeft,
  Clock3,
  FileKey2,
  LogIn,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";

import { getWebSessionState } from "@/auth/auth0-client";
import { AccountDataControls } from "@/components/account-data-controls";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  await connection();
  const session = await getWebSessionState();

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

      <section className="account-panel" aria-labelledby="account-data-heading">
        <div className="account-eyebrow">
          <ShieldCheck size={16} aria-hidden="true" />
          Privacy and data controls
        </div>
        <h1 id="account-data-heading">Your evidence, on your terms.</h1>
        <p className="account-lede">
          Export the complete tenant archive, understand what ReproForge keeps,
          or permanently remove the account. These controls use your web session;
          they never ask for an OpenAI or GitHub API token.
        </p>

        {session.status === "signed_in" ? (
          <>
            <div className="account-card" data-session-state="signed-in">
              <div>
                <p className="account-label">Data owner</p>
                <p className="account-name">{session.account.displayName}</p>
                {session.account.email ? (
                  <p className="account-email">{session.account.email}</p>
                ) : null}
              </div>
              <div className="account-actions">
                <a className="secondary-button" href="/auth/logout">Sign out</a>
              </div>
            </div>
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
                Sign in to export or delete tenant data.
              </p>
            </div>
            {session.status === "signed_out" ? (
              <a className="primary-button" href="/auth/login?returnTo=/account">
                <LogIn size={17} aria-hidden="true" />
                Sign in with Auth0
              </a>
            ) : null}
          </div>
        )}

        <AccountDataControls enabled={session.status === "signed_in"} />

        <div className="data-policy-grid" aria-label="Data lifecycle policy">
          <article>
            <Clock3 size={18} aria-hidden="true" />
            <h2>30-day customer data</h2>
            <p>Source, run evidence, cases, and bundles default to 30 days. Account lifecycle records default to 365 days.</p>
          </article>
          <article>
            <Archive size={18} aria-hidden="true" />
            <h2>Verifiable export</h2>
            <p>Every archive carries a canonical manifest hash and the original content-addressed private object bytes.</p>
          </article>
          <article>
            <FileKey2 size={18} aria-hidden="true" />
            <h2>Provider-first deletion</h2>
            <p>Private objects are removed before database state. A failed provider delete stops the purge and remains retryable.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
