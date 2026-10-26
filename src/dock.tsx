import React from "react";
import ReactDOM from "react-dom/client";
import { DockWindow } from "./components/DockWindow";
import "./styles.css";
import "./typography.css";

document.documentElement.classList.add("dock-window");
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><DockWindow /></React.StrictMode>);
import "./themes.css";
