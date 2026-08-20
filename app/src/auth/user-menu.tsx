import type { ReactElement } from "react";
import { UserButton } from "@clerk/clerk-react";

export function UserMenu(): ReactElement {
  return (
    <UserButton
      afterSignOutUrl="/sign-in"
      appearance={{
        elements: {
          avatarBox: "h-7 w-7",
        },
      }}
    />
  );
}
