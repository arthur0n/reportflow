// app/src/providers/TrpcProvider.tsx
//
// Wires the auth provider's getToken into the tRPC client via setTokenGetter,
// then nests the tRPC + React Query providers. Lives in its own file so
// main.tsx only exports the root render (keeps react-refresh/only-export-
// components happy).

import type { ReactNode } from "react";
import { useSession } from "@/auth";
import { QueryClientProvider } from "@tanstack/react-query";
import { trpc, trpcClient, queryClient, setTokenGetter } from "@/shared/lib/trpc";

export function TrpcProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { getToken } = useSession();
  setTokenGetter(getToken);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
