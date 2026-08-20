import { useUser } from "@clerk/clerk-react";

export type CurrentUser = {
  id: string;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
};

export function useCurrentUser(): CurrentUser | null {
  const { user, isLoaded } = useUser();
  if (!isLoaded || !user) return null;
  return {
    id: user.id,
    name: user.fullName,
    email: user.primaryEmailAddress?.emailAddress ?? null,
    imageUrl: user.imageUrl,
  };
}
