import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "@/app/App";
import "@/styles/global.css";
import { initTheme } from "@/shared/lib/theme";
import { useBranding } from "@/shared/branding";
import { cleanupLegacyBrowserAuth } from "@/shared/lib/keyring";

// SEC-019A: purge any legacy localStorage refresh token from older browser
// builds before auth restore runs (the token now lives in an HttpOnly cookie).
cleanupLegacyBrowserAuth();

initTheme();
// Load instance branding (name/logo) from the server; sets document.title.
void useBranding.getState().load();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
