import { useAuth } from "@clerk/clerk-react";

export type Session = {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
};

export function useSession(): Session {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  return {
    isLoaded,
    isSignedIn: isSignedIn === true,
    getToken: () => getToken(),
    signOut: async () => {
      await signOut();
    },
  };
}
