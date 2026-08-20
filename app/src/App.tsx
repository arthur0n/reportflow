import type { ReactElement } from "react";
import { Route, Switch, Redirect } from "wouter";
import { Protected } from "@/auth";
import { SignInPage } from "./pages/SignInPage";
import { AdminGate } from "./pages/AdminGate";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { CalibratePage } from "./pages/CalibratePage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { RevisarPage } from "./features/extraction/RevisarPage";
import { TenantValuesKindPage } from "./pages/TenantValuesKindPage";
import { AdminLovCatalogPage } from "./pages/AdminLovCatalogPage";

export default function App(): ReactElement {
  return (
    <Switch>
      {/* Clerk's multi-step sign-in navigates to sub-paths like
          /sign-in/factor-two. The optional param keeps SignIn mounted. */}
      <Route path="/sign-in/:rest?" component={SignInPage} />
      {/* No self-serve sign-up: accounts are created by hand in Clerk and
          matched with a local users row (project_conventions §7). */}
      <Route path="/sign-up/:rest?">
        <Redirect to="/sign-in" />
      </Route>
      <Route path="/dashboard">
        <Protected>
          <DashboardPage />
        </Protected>
      </Route>
      <Route path="/documents">
        <Protected>
          <DocumentsPage />
        </Protected>
      </Route>
      {/* §4.2's repair screen. Reachable from the documents list whenever a
          document has an extraction to look at — not only when the job is in
          `revisar`, since a validated-but-wrong read is exactly the failure
          nothing else surfaces (§3.3). */}
      <Route path="/documentos/:id/revisar">
        <Protected>
          <RevisarPage />
        </Protected>
      </Route>
      <Route path="/calibrate">
        <Protected>
          <CalibratePage />
        </Protected>
      </Route>
      {/* The OUTPUT axis (§3.2): authoring a template, and the reports that
          pin one of its versions. Two screens because the two things have
          different lifetimes — a template version is immutable and shared,
          a report is a draft until it is frozen (§5.1/§5.3). */}
      <Route path="/templates">
        <Protected>
          <TemplatesPage />
        </Protected>
      </Route>
      <Route path="/reports">
        <Protected>
          <ReportsPage />
        </Protected>
      </Route>
      <Route path="/parameters/tenant-values/:slug">
        <Protected>
          <TenantValuesKindPage />
        </Protected>
      </Route>
      <Route path="/parameters">
        <Redirect to="/parameters/tenant-values/supplier" />
      </Route>
      <Route path="/admin/lov">
        <Protected>
          <AdminGate>
            <AdminLovCatalogPage />
          </AdminGate>
        </Protected>
      </Route>
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route>
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-muted-foreground">Página não encontrada.</p>
        </div>
      </Route>
    </Switch>
  );
}
