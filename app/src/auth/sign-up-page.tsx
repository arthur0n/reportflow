// app/src/auth/sign-up-page.tsx
//
// Single-page three-step self-service signup. Steps live in component state
// (no route changes between them) so a refresh restarts the flow — Clerk's
// in-progress signUp object is per-tab anyway.
//
// The route still mounts at /sign-up (see app/src/App.tsx). The pt-BR display
// text + branding live here; the Clerk-hosted SignUp widget is no longer
// rendered for self-service.

import { useState, type ReactElement } from "react";
import { SignUpStepAccount } from "./sign-up-step-account";
import { SignUpStepVerify } from "./sign-up-step-verify";
import { SignUpStepBusiness } from "./sign-up-step-business";

type Step = "account" | "verify" | "business";

type Account = {
  firstName: string;
  lastName: string;
  email: string;
};

const STEP_ORDER: Step[] = ["account", "verify", "business"];

const STEP_LABEL: Record<Step, string> = {
  account: "Sua conta",
  verify: "Confirmar e-mail",
  business: "Seu negócio",
};

export function SignUpFlow(): ReactElement {
  const [step, setStep] = useState<Step>("account");
  const [account, setAccount] = useState<Account | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator current={step} />
      {step === "account" ? (
        <SignUpStepAccount
          onSuccess={(data) => {
            setAccount(data);
            setStep("verify");
          }}
        />
      ) : null}
      {step === "verify" && account !== null ? (
        <SignUpStepVerify
          email={account.email}
          onSuccess={() => {
            setStep("business");
          }}
        />
      ) : null}
      {step === "business" && account !== null ? <SignUpStepBusiness account={account} /> : null}
    </div>
  );
}

function StepIndicator({ current }: { current: Step }): ReactElement {
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <ol className="flex items-center gap-3 text-[length:var(--fs-eyebrow)] uppercase tracking-[0.08em] text-[color:var(--ink-mute)]">
      {STEP_ORDER.map((s, i) => {
        const isActive = i === currentIndex;
        const isDone = i < currentIndex;
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              className={
                isActive
                  ? "text-[color:var(--accent)] font-[600]"
                  : isDone
                    ? "text-[color:var(--ink-soft)]"
                    : ""
              }
            >
              {String(i + 1).padStart(2, "0")} · {STEP_LABEL[s]}
            </span>
            {i < STEP_ORDER.length - 1 ? (
              <span className="text-[color:var(--ink-mute)]">/</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
