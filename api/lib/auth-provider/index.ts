// api/lib/auth-provider/index.ts
//
// Single export of the active AuthProvider. To swap providers (e.g. Cognito),
// import a different impl here. Callers should depend on `authProvider`, never
// on a specific implementation file.

import { clerkAuthProvider } from "./clerk";
import type { AuthProvider } from "./types";

export const authProvider: AuthProvider = clerkAuthProvider;
export type { AuthProvider, VerifiedToken } from "./types";
