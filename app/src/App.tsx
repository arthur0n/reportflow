import type { ReactElement } from "react";
import { Route, Switch, Redirect } from "wouter";
import { Protected } from "@/auth";
import { SignInPage } from "./pages/SignInPage";
import { AdminGate } from "./pages/AdminGate";
import { DashboardPage } from "./pages/DashboardPage";
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
