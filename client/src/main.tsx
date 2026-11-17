import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { OwnerAccessProvider } from "./contexts/OwnerAccessContext";
import { fetchProtected, notifyOwnerSessionExpired } from "./lib/owner-access";
import "./index.css";

const queryClient = new QueryClient();

const lockWorkspaceIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (error.data?.code === "UNAUTHORIZED" || error.data?.httpStatus === 401)
    notifyOwnerSessionExpired();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    lockWorkspaceIfUnauthorized(error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    lockWorkspaceIfUnauthorized(error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return fetchProtected(input, {
          ...(init ?? {}),
          credentials: "same-origin",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <OwnerAccessProvider>
        <App />
      </OwnerAccessProvider>
    </QueryClientProvider>
  </trpc.Provider>
);
