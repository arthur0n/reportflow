import type { ReactElement } from "react";
import { Route, Switch, Redirect } from "wouter";
import { Protected } from "@/auth";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ImportsPage } from "./pages/ImportsPage";
import { ImportBankPage } from "./pages/ImportBankPage";
import { ImportAcquirerPage } from "./pages/ImportAcquirerPage";
import { ImportDetailPage } from "./pages/ImportDetailPage";
import { ConciliationPage } from "./pages/ConciliationPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { PaymentMethodsPage } from "./pages/PaymentMethodsPage";
import { TenantValuesKindPage } from "./pages/TenantValuesKindPage";
import { ReportsPage } from "./pages/ReportsPage";
import { QuestionsPage } from "./pages/QuestionsPage";
import { AdminCustomersNewPage } from "./pages/AdminCustomersNewPage";
import { AdminLovCandidatesPage } from "./pages/AdminLovCandidatesPage";
import { AdminLovCatalogPage } from "./pages/AdminLovCatalogPage";
import { ImportRulesPage } from "./pages/ImportRulesPage";
import { AdminSystemMatchRulesPage } from "./pages/AdminSystemMatchRulesPage";
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
      <Route path="/transactions">
        <Protected>
          <TransactionsPage />
        </Protected>
      </Route>
      <Route path="/categories">
        <Protected>
          <CategoriesPage />
        </Protected>
      </Route>
      <Route path="/parameters/payment-methods">
        <Protected>
          <PaymentMethodsPage />
        </Protected>
      </Route>
      <Route path="/parameters/tenant-values/:slug">
        <Protected>
          <TenantValuesKindPage />
        </Protected>
      </Route>
      <Route path="/parameters">
        <Redirect to="/parameters/payment-methods" />
      </Route>
      <Route path="/imports">
        <Protected>
          <ImportsPage />
        </Protected>
      </Route>
      <Route path="/imports/bank">
        <Protected>
          <ImportBankPage />
        </Protected>
      </Route>
      <Route path="/imports/acquirer">
        <Protected>
          <ImportAcquirerPage />
        </Protected>
      </Route>
      <Route path="/imports/:id">
        <Protected>
          <ImportDetailPage />
        </Protected>
      </Route>
      <Route path="/conciliation">
        <Protected>
          <ConciliationPage />
        </Protected>
      </Route>
      <Route path="/reports">
        <Protected>
          <ReportsPage />
        </Protected>
      </Route>
      <Route path="/feedback">
        <Protected>
          <QuestionsPage />
        </Protected>
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
      <Route path="/parameters/import-rules">
        <Protected>
          <ImportRulesPage />
        </Protected>
      </Route>
      <Route path="/admin/match-rules-system">
        <Protected>
          <AdminSystemMatchRulesPage />
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
