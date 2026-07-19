import { Download, FileCode2, PackageCheck, ShieldCheck } from "lucide-react";

import type { SampleCaseResult } from "@/application/sample-case";

type BundlePanelProps = {
  bundle: SampleCaseResult["bundle"];
  files: SampleCaseResult["files"];
};

export function BundlePanel({ bundle, files }: BundlePanelProps) {
  return (
    <section aria-labelledby="bundle-heading">
      <header className="bundle-header">
        <PackageCheck size={21} aria-hidden="true" />
        <div>
          <h2 id="bundle-heading">Repro Bundle</h2>
          <p>Portable proof · schema {bundle.schemaVersion}</p>
        </div>
      </header>
      <ul className="file-list">
        {Object.keys(files).map((file) => (
          <li className="file-item" key={file}>
            <FileCode2 size={13} aria-hidden="true" />
            <span>{file}</span>
            <span className="file-status">ready</span>
          </li>
        ))}
      </ul>
      <p className="bundle-hash">
        sha256 · {bundle.bundleHash.slice(0, 20)}…{bundle.bundleHash.slice(-8)}
      </p>
      <a className="download-button" href="/api/sample/bundle" download>
        <Download size={15} aria-hidden="true" />
        Download Repro Bundle
      </a>
      <p className="truth-note">
        <ShieldCheck size={14} aria-hidden="true" />
        Redacted, content-addressed, and runnable without an AI model.
      </p>
    </section>
  );
}
