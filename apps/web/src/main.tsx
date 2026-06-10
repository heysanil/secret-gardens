import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { BootstrapGate, RequireSession } from "./gates";
import "./index.css";
import { AccountTokensPage } from "./pages/AccountTokensPage";
import { CliAuthPage } from "./pages/CliAuthPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProjectAuditPage } from "./pages/ProjectAuditPage";
import { ProjectLayout } from "./pages/ProjectLayout";
import { ProjectMembersPage } from "./pages/ProjectMembersPage";
import { ProjectSecretsPage } from "./pages/ProjectSecretsPage";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SetupPage } from "./pages/SetupPage";
import { AppShell } from "./shell/AppShell";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<BootstrapGate />}>
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route element={<RequireSession />}>
                  <Route path="/cli-auth" element={<CliAuthPage />} />
                  <Route element={<AppShell />}>
                    <Route path="/" element={<ProjectsPage />} />
                    <Route
                      path="/projects/:projectId"
                      element={<ProjectLayout />}
                    >
                      <Route index element={<ProjectSecretsPage />} />
                      <Route path="audit" element={<ProjectAuditPage />} />
                      <Route path="members" element={<ProjectMembersPage />} />
                      <Route
                        path="settings"
                        element={<ProjectSettingsPage />}
                      />
                    </Route>
                    <Route
                      path="/account/tokens"
                      element={<AccountTokensPage />}
                    />
                  </Route>
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
