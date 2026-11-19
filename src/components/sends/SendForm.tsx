"use client";

// The ad-hoc send form (SHA-2959).
//
// Sean's bar: "as little as a customer email address" must be enough to
// send — but ask for as much as we can get. So the form is PROGRESSIVE: one
// required field is on screen, and the five optional ones are one click
// away and stay open once opened. The submit button never depends on them.
//
// Imports only the PURE half of the send lane (./fields, ./merge), so no
// database or server module reaches the client bundle.

import { useMemo, useState } from "react";

import {
  OPTIONAL_RECIPIENT_FIELDS,
  RECIPIENT_FIELD_LABELS,
  validateRecipientInput,
  type RecipientInput,
} from "@/lib/sends/fields";
import { recipientMergeVars } from "@/lib/sends/merge";

export type SendFormDocument = {
  versionId: number;
  label: string;
};

const FIELD_TYPE: Partial<Record<keyof RecipientInput, string>> = {
  phone: "tel",
};

const PLACEHOLDER: Partial<Record<keyof RecipientInput, string>> = {
  email: "client@their-company.example",
  fullName: "Dana Reyes",
  companyName: "Reyes Dental",
  legalName: "Reyes Dental Group LLC",
  address: "100 Main St, Springfield, IL 62701",
  phone: "+1 555 010 0100",
};

const INPUT_CLASS = "mt-1 block w-full rounded border border-slate-300 p-2";

export function SendForm({
  documents,
  action,
}: {
  documents: SendFormDocument[];
  action: (formData: FormData) => void;
}) {
  const [values, setValues] = useState<RecipientInput>({
    email: "",
    fullName: "",
    companyName: "",
    legalName: "",
    address: "",
    phone: "",
  });
  const [showOptional, setShowOptional] = useState(false);
  const [touchedEmail, setTouchedEmail] = useState(false);

  const validation = useMemo(() => validateRecipientInput(values), [values]);
  // Only complain once they have left the field: validating an email the
  // moment the first character lands tells everyone they are wrong.
  const emailError = touchedEmail && !validation.ok ? validation.error : null;

  // What the contract will actually say, from the pure merge used server-side.
  const merged = useMemo(() => recipientMergeVars(values), [values]);
  const captured = OPTIONAL_RECIPIENT_FIELDS.filter((f) => values[f].trim() !== "").length;

  const set = (field: keyof RecipientInput) => (value: string) =>
    setValues((previous) => ({ ...previous, [field]: value }));

  return (
    <form action={action} className="mt-4 space-y-4 text-sm">
      <label className="block">
        Document
        <select name="documentVersionId" className={INPUT_CLASS} defaultValue={documents[0]?.versionId}>
          {documents.map((doc) => (
            <option key={doc.versionId} value={doc.versionId}>
              {doc.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        {RECIPIENT_FIELD_LABELS.email} <span className="text-red-600">*</span>
        <input
          name="email"
          type="email"
          required
          value={values.email}
          onChange={(e) => set("email")(e.target.value)}
          onBlur={() => setTouchedEmail(true)}
          placeholder={PLACEHOLDER.email}
          aria-invalid={emailError !== null}
          aria-describedby={emailError ? "send-email-error" : undefined}
          className={INPUT_CLASS}
        />
        <span className="mt-1 block text-slate-500">
          This is the only field we need. Everything else is optional.
        </span>
        {emailError ? (
          <span id="send-email-error" className="mt-1 block text-red-700">
            {emailError}
          </span>
        ) : null}
      </label>

      {showOptional ? (
        <fieldset className="rounded border border-slate-200 p-3">
          <legend className="px-1 text-slate-500">
            Optional details — merged into the agreement when present
          </legend>
          {OPTIONAL_RECIPIENT_FIELDS.map((field) => (
            <label key={field} className="mt-2 block first:mt-0">
              {RECIPIENT_FIELD_LABELS[field]}
              <input
                name={field}
                type={FIELD_TYPE[field] ?? "text"}
                value={values[field]}
                onChange={(e) => set(field)(e.target.value)}
                placeholder={PLACEHOLDER[field]}
                className={INPUT_CLASS}
              />
            </label>
          ))}
        </fieldset>
      ) : (
        <button
          type="button"
          onClick={() => setShowOptional(true)}
          className="rounded border border-slate-300 px-3 py-1.5 text-slate-700"
        >
          Add contact and company details ({OPTIONAL_RECIPIENT_FIELDS.length} optional fields)
        </button>
      )}

      <div className="rounded border border-slate-200 bg-slate-50 p-3">
        <div className="font-medium text-slate-700">
          The agreement will name {captured === 0 ? "the Client generically" : `${captured} captured detail${captured === 1 ? "" : "s"}`}
        </div>
        {Object.keys(merged).length === 0 ? (
          <p className="mt-1 text-slate-500">
            With only an email address, every client reference reads as generic prose
            (&ldquo;the Client&rdquo;). The agreement is still complete.
          </p>
        ) : (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-slate-600">
            {Object.entries(merged).map(([token, value]) => (
              <div key={token} className="col-span-2 grid grid-cols-subgrid">
                <dt className="font-mono text-xs text-slate-500">{`{{${token}}}`}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <button
        type="submit"
        disabled={documents.length === 0}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:bg-slate-400"
      >
        Create unique link and send
      </button>
    </form>
  );
}
