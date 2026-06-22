import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./i18n";
import { applyAccent, getAccent } from "./theme";
import "./styles.css";

applyAccent(getAccent());   // couleur d'accent personnalisée, avant le 1er rendu

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
