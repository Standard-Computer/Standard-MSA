"use client";

// A submit button that disables itself while its form is in flight.
//
// The first line of defence against a double-clicked server action. For the
// update notice a second POST means every prior recipient is told twice that
// their terms changed, which is a mail nobody can un-send — so the durable
// guard lives in `sendUpdateNotice` (exactly once per recipient per version)
// and this stops the second request being made at all.
//
// Imports nothing but react-dom's form status, so no server module reaches
// the client bundle.

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pendingLabel,
  disabled = false,
  className,
}: {
  children: React.ReactNode;
  /** Shown instead of `children` while submitting. */
  pendingLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} aria-busy={pending} className={className}>
      {pending ? pendingLabel : children}
    </button>
  );
}
