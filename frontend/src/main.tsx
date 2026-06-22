import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./i18n";
import { applyAccent, applyTheme, getAccent, getThemeId } from "./theme";
import "./styles.css";

applyTheme(getThemeId());   // palette + accent personnalisés, avant le 1er rendu
applyAccent(getAccent());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
