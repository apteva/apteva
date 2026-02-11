import React from "react";
import { render } from "ink";
import { App } from "./App.js";

const baseUrl = process.argv[2] || "http://localhost:4280";

render(<App baseUrl={baseUrl} />);
