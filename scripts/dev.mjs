#!/usr/bin/env node
import process from "node:process";
import { developmentStatus, linkDevelopment, unlinkDevelopment } from "./dev-mode.mjs";

const command = process.argv[2];

try {
  let result;
  if (command === "link") result = await linkDevelopment();
  else if (command === "status") result = await developmentStatus();
  else if (command === "unlink") result = await unlinkDevelopment();
  else throw new Error("Usage: node scripts/dev.mjs <link|status|unlink>");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 1;
}
