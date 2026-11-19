// Re-run diff (SHA-2956): what the wizard is about to change.
//
// Sean's requirement is that re-running onboarding "safely update existing
// values and show what changed". The confirm step calls this with the saved
// row and the pending input; the settings page calls it after a save to echo
// what just changed. PURE — both the client component and the tests use it.

import {
  IDENTITY_FIELD_LABELS,
  type MspIdentityInput,
} from "./fields";

export type IdentityChange = {
  field: keyof MspIdentityInput;
  label: string;
  /** "" means the field was blank before (first run, or never filled). */
  before: string;
  after: string;
};

/**
 * Field-by-field changes between the stored values and a pending input.
 * Unchanged fields are omitted; an empty result means the re-run is a
 * no-op and nothing needs confirming as "changed".
 */
export function identityChanges(
  before: MspIdentityInput,
  after: MspIdentityInput,
): IdentityChange[] {
  const changes: IdentityChange[] = [];
  for (const field of Object.keys(IDENTITY_FIELD_LABELS) as (keyof MspIdentityInput)[]) {
    const a = before[field].trim();
    const b = after[field].trim();
    if (a !== b) {
      changes.push({ field, label: IDENTITY_FIELD_LABELS[field], before: a, after: b });
    }
  }
  return changes;
}
