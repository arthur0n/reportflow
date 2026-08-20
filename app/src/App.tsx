import type { ReactElement } from "react";
import { Route, Switch, Redirect } from "wouter";
import { Protected } from "@/auth";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { DashboardPage } from "./pages/DashboardPage";
import { TenantValuesKindPage } from "./pages/TenantValuesKindPage";
import { AdminCustomersNewPage } from "./pages/AdminCustomersNewPage";
import { AdminLovCandidatesPage } from "./pages/AdminLovCandidatesPage";
import { AdminLovCatalogPage } from "./pages/AdminLovCatalogPage";
import { SettingsTenantPage } from "./pages/SettingsTenantPage";

export default function App(): ReactElement {
  return (
    <Switch>
      {/* Clerk's multi-step sign-in navigates to sub-paths like
          /sign-in/factor-two. The optional param keeps SignIn mounted. */}
      <Route path="/sign-in/:rest?" component={SignInPage} />
      <Route path="/sign-up/:rest?" component={SignUpPage} />
      <Route path="/dashboard">
        <Protected>
          <DashboardPage />
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
          <AdminLovCatalogPage />
        </Protected>
      </Route>
      <Route path="/admin/lov-candidates">
        <Protected>
          <AdminLovCandidatesPage />
        </Protected>
      </Route>
      <Route path="/admin/customers/new">
        <Protected>
          <AdminCustomersNewPage />
        </Protected>
      </Route>
      <Route path="/settings/tenant">
        <Protected>
          <SettingsTenantPage />
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
