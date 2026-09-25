#!/usr/bin/env node
// `avr-mcp`: the MCP server as its own binary, for MCP client configs that want a single command.
import { runMcpServer } from "./mcp.js";

await runMcpServer();
