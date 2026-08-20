import type { ReactElement } from "react";
import { SignIn } from "@clerk/clerk-react";
import { authWidgetAppearance } from "./appearance";

export function SignInWidget(): ReactElement {
  return (
    <SignIn
      routing="path"
      path="/sign-in"
      forceRedirectUrl="/dashboard"
      appearance={authWidgetAppearance}
    />
  );
}
