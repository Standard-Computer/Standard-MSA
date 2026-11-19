"use client";

// API key creation (SHA-2960). Client component so the one-time plaintext
// can render inline from the action's return value — never via a URL.

import { useActionState } from "react";
import { API_SCOPES } from "@/lib/api/scopes";
import { createApiKeyAction, type CreateKeyState } from "./actions";

export default function CreateKeyForm() {
  const [state, formAction, pending] = useActionState<CreateKeyState, FormData>(
    createApiKeyAction,
    { status: "idle" },
  );

  if (state.status === "created") {
    return (
      <div className="mt-3 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
        <p>
          Key created for <strong>{state.name}</strong>. Copy it now — it is shown only once
          and stored only as a hash:
        </p>
        <code className="mt-2 block break-all rounded bg-white p-2 font-mono text-xs">
          {state.plaintext}
        </code>
        <p className="mt-2 text-slate-600">
          Use it as <code>Authorization: Bearer &lt;key&gt;</code> against <code>/api/v1</code>.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-3 space-y-3 text-sm">
      {state.status === "error" ? (
        <p className="rounded border border-red-300 bg-red-50 p-2">{state.error}</p>
      ) : null}
      <label className="block">
        <span className="text-slate-700">Integration name</span>
        <input
          name="name"
          required
          placeholder="e.g. HaloPSA bridge"
          className="mt-1 w-full rounded border border-slate-300 p-2"
        />
      </label>
      <fieldset>
        <legend className="text-slate-700">
          Scopes — leave all unticked to grant everything
        </legend>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {API_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-2">
              <input type="checkbox" name="scopes" value={scope} />
              <code className="text-xs">{scope}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create API key"}
      </button>
    </form>
  );
}
