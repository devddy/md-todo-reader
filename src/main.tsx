import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Both windows load index.html; the notch panel gets its own root. Dynamic
// imports keep each window's stylesheet out of the other.
const isNotch = getCurrentWebviewWindow().label === "notch";
const root = isNotch ? import("./NotchPanel") : import("./App");

root.then(({ default: Root }) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
