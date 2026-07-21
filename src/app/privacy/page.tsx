import type { Metadata } from "next";
import Link from "next/link";

import { PolicyPage } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Privacy — ReproForge",
  description: "How ReproForge handles repository, account, and reproduction data.",
};

export default function PrivacyPage() {
  return (
    <PolicyPage
      eyebrow="Privacy notice"
      title="Bounded inputs. Auditable retention."
      lede="ReproForge is designed to turn authorized, immutable source into sanitized reproduction evidence without accepting your ChatGPT credential or an OpenAI API key."
    >
      <section>
        <h2>What the product processes</h2>
        <p>
          The offline demo uses only a bundled synthetic issue and fixture. The hosted
          private beta may process your GitHub sign-in identifier (brokered by Auth0),
          the GitHub repositories you explicitly authorize, an exact commit, issue metadata, bounded command
          output, reproduction evidence, bundle bytes, and operational audit records.
        </p>
        <p>
          ReproForge does not accept free-form ChatGPT conversation text, pasted repository
          source, or your GitHub, ChatGPT, or OpenAI credentials as tool arguments.
        </p>
      </section>

      <section>
        <h2>Providers and purpose</h2>
        <ul>
          <li><strong>Auth0</strong> provides account sign-in and OAuth authorization.</li>
          <li><strong>GitHub</strong> provides authorized repository metadata and immutable source archives.</li>
          <li><strong>Neon Postgres</strong> stores tenant-keyed cases, evidence metadata, quotas, and audit state.</li>
          <li><strong>Vercel</strong> hosts the product, private bundle objects, queues, and disposable isolated runners.</li>
          <li>
            The <strong>OpenAI Responses API</strong> is used only if an operator explicitly
            enables the optional live investigator. That path sends the submitted metadata
            and evidence with storage disabled; the normal ChatGPT subscription path does
            not require it.
          </li>
        </ul>
      </section>

      <section>
        <h2>Retention and deletion</h2>
        <p>
          Cases, jobs, idempotency records, run evidence, outbox events, and trusted bundle
          artifacts default to 30 days. Audit, quota, deletion, and principal records default
          to 365 days. Eligible private objects are deleted before their database records;
          one sanitized audit tombstone may remain.
        </p>
        <p>
          A signed-in user can request a portable, integrity-checked export or explicitly
          request account deletion from the <Link href="/account">account data controls</Link>.
        </p>
      </section>

      <section>
        <h2>Analytics, advertising, and logs</h2>
        <p>
          <strong>No first-party analytics or advertising</strong> integration is enabled.
          Hosting and identity providers may produce infrastructure and security logs under
          their own controls. ReproForge operational views are aggregate-only and redact
          credential-shaped values.
        </p>
      </section>

      <section>
        <h2>Your responsibility</h2>
        <p>
          Use synthetic or authorized canary source during the private beta. Do not submit
          credentials, regulated data, customer data, or private source you are not allowed
          to process. Redaction is a defense in depth, not a substitute for safe inputs.
        </p>
      </section>
    </PolicyPage>
  );
}
