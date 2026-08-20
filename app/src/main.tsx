// app/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "@/auth";
import { TrpcProvider } from "@/providers/TrpcProvider";
import { PeriodProvider } from "@/shared/period-context";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element in index.html");

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <TrpcProvider>
        <PeriodProvider>
          <App />
        </PeriodProvider>
      </TrpcProvider>
    </AuthProvider>
  </StrictMode>,
);
