import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";

const policyLinks = [
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
  ["Support", "/support"],
  ["Security", "/security"],
] as const;

type PolicyPageProps = {
  children: ReactNode;
  eyebrow: string;
  lede: string;
  title: string;
};

export function PolicyPage({ children, eyebrow, lede, title }: PolicyPageProps) {
  return (
    <main className="policy-shell">
      <nav className="policy-topbar" aria-label="Product navigation">
        <Link href="/" className="policy-brand-link">
          <BrandMark />
        </Link>
        <Link href="/">Back to ReproForge</Link>
      </nav>

      <div className="policy-layout">
        <aside className="policy-sidebar">
          <p>Product policies</p>
          <nav aria-label="Policy navigation">
            {policyLinks.map(([label, href]) => (
              <Link key={href} href={href}>{label}</Link>
            ))}
          </nav>
        </aside>

        <article className="policy-document">
          <header className="policy-hero">
            <p className="policy-eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p>{lede}</p>
            <span>Last updated July 20, 2026</span>
          </header>
          <div className="policy-body">{children}</div>
        </article>
      </div>

      <footer className="policy-footer">
        <span>ReproForge private beta</span>
        <span>Evidence first. Least privilege. No hidden execution.</span>
      </footer>
    </main>
  );
}

