import { Hammer } from "lucide-react";

export function BrandMark() {
  return (
    <span className="brand" aria-label="ReproForge">
      <span className="brand-mark" aria-hidden="true">
        <Hammer size={17} strokeWidth={2.1} />
      </span>
      ReproForge
    </span>
  );
}
