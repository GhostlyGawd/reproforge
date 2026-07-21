import type { Metadata } from "next";
import Link from "next/link";

import { PolicyPage } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Security — ReproForge",
  description: "ReproForge's execution boundary and private vulnerability reporting path.",
};

export default function SecurityPage() {
  return (
    <PolicyPage
      eyebrow="Security"
      title="Untrusted source never gets ambient trust."
      lede="ReproForge narrows authorization on the trusted host, binds every run to an immutable commit, and executes source in a disposable deny-all sandbox."
    >
      <section>
        <h2>Report a vulnerability</h2>
        <p>
          Use GitHub&apos;s private <strong>Report a vulnerability</strong> option from the{" "}
          <a
            href="https://github.com/GhostlyGawd/reproforge/security/policy"
            rel="noreferrer"
          >
            repository security policy
          </a>. If that option is unavailable, contact the owner through a private method
          listed on the <a href="https://github.com/GhostlyGawd" rel="noreferrer">GhostlyGawd profile</a>.
          Use a synthetic proof and never include a real credential or customer data.
        </p>
      </section>

      <section>
        <h2>Execution boundary</h2>
        <ul>
          <li>Repository access is selected from a server-authorized GitHub installation.</li>
          <li>Every case is bound to an exact commit rather than a mutable branch.</li>
          <li>Installation credentials remain on the trusted host and never enter the runner.</li>
          <li>Source is injected into a disposable sandbox with outbound network denied.</li>
          <li>Commands, budgets, output, artifact size, and lifecycle are bounded.</li>
          <li>Durable evidence is sanitized; raw repository source is not a durable artifact.</li>
        </ul>
      </section>

      <section>
        <h2>Identity and API boundary</h2>
        <p>
          Auth0 issues short-lived, audience-bound OAuth tokens with PKCE. ReproForge checks
          issuer, audience, signature, expiry, scopes, tenant identity, and resource
          authorization. ChatGPT connects through OAuth; it does not receive a ReproForge
          API key or GitHub installation credential.
        </p>
      </section>

      <section>
        <h2>Known limits</h2>
        <p>
          This is a private beta, not a general-purpose code execution service. Defense in
          depth cannot make unauthorized or sensitive inputs appropriate. Review the{" "}
          <Link href="/terms">terms</Link> and <Link href="/privacy">privacy notice</Link>
          before using an authorized canary repository.
        </p>
      </section>
    </PolicyPage>
  );
}

