import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GuestApp } from "./guest/GuestApp";
import { registerServiceWorker } from "./offline";
import "./styles.css";

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.replace(/\/+$/, "") === "/join" ? <GuestApp /> : <App />}
  </StrictMode>,
);
