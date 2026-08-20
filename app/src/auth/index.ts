// app/src/auth/index.ts
//
// The single import surface for auth in the app. Outside this folder, no file
// should import from `@clerk/*` — go through here. To swap providers, replace
// the implementations in this folder; the rest of the app keeps compiling.

export { AuthProvider } from "./provider";
export { Protected } from "./protected";
export { SignInWidget } from "./sign-in-widget";
export { SignUpFlow } from "./sign-up-page";
export { UserMenu } from "./user-menu";
export { useSession } from "./use-session";
export type { Session } from "./use-session";
export { useCurrentUser } from "./use-current-user";
export type { CurrentUser } from "./use-current-user";
