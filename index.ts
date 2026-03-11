import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { randomBytes, createHash } from "crypto";

const SF_CLIENT_ID     = process.env.SF_CLIENT_ID!;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET!;
const SF_LOGIN_URL     = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const SF_API_VERSION   = process.env.SF_API_VERSION || "v60.0";
const SF_CALLBACK_PORT = parseInt(process.env.SF_CALLBACK_PORT || "8788");
const SF_CALLBACK_URL  = `http://localhost:${SF_CALLBACK_PORT}/oauth/callback`;
const TOKEN_FILE       = path.join(os.homedir(), ".salesforce-mcp-session.json");

interface Session {
  accessToken: string;
  refreshToken: string;
  instanceUrl: string;
  userId: string;
  username: string;
}

let session: Session | null = null;

function loadSession(): Session | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8")) as Session;
    }
  } catch { /* ignore */ }
  return null;
}

function saveSession(s: Session) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function clearSession() {
  session = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
}

// Load persisted session on startup
session = loadSession();

async function refreshAccessToken(): Promise<boolean> {
  if (!session?.refreshToken) return false;
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      refresh_token: session.refreshToken,
    }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as any;
  session = { ...session, accessToken: data.access_token, instanceUrl: data.instance_url };
  saveSession(session);
  return true;
}

async function sfRequest(method: string, path: string, body?: object): Promise<{ ok: boolean; status: number; data: any }> {
  if (!session) {
    throw new Error("Not logged in. Use the sf_login tool to connect your Salesforce account.");
  }

  const doRequest = () => fetch(`${session!.instanceUrl}/services/data/${SF_API_VERSION}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session!.accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let res = await doRequest();

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error("Session expired. Use the sf_login tool to reconnect.");
    res = await doRequest();
  }

  if (res.status === 204) return { ok: true, status: 204, data: null };
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Kick off the browser-based OAuth flow. Resolves when the user finishes logging in.
async function initiateLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString("hex");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const authUrl = `${SF_LOGIN_URL}/services/oauth2/authorize?` + new URLSearchParams({
      response_type: "code",
      client_id: SF_CLIENT_ID,
      redirect_uri: SF_CALLBACK_URL,
      scope: "api refresh_token",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/oauth/callback")) return;

      const url = new URL(req.url, `http://localhost:${SF_CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>❌ Login failed: ${error}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`Salesforce login failed: ${error} — ${url.searchParams.get("error_description") ?? ""}`));
        return;
      }

      if (returnedState !== state || !code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>❌ Invalid callback</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error("OAuth state mismatch or missing code"));
        return;
      }

      try {
        // Exchange code for tokens
        const tokenRes = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: SF_CLIENT_ID,
            client_secret: SF_CLIENT_SECRET,
            redirect_uri: SF_CALLBACK_URL,
            code,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          throw new Error(`Token exchange failed: ${err}`);
        }

        const tokenData = (await tokenRes.json()) as any;

        // Fetch the authenticated user's info
        const userRes = await fetch(`${tokenData.instance_url}/services/oauth2/userinfo`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userInfo = (await userRes.json()) as any;

        session = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          instanceUrl: tokenData.instance_url,
          userId: userInfo.user_id,
          username: userInfo.preferred_username,
        };
        saveSession(session);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>✅ Connected as ${session.username}</h2><p>You can close this tab and return to Claude.</p></body></html>`);
        server.close();
        resolve(`✅ Logged in as ${session.username} (${session.userId})\nAll Salesforce actions will now run as this user and respect their permissions, FLS, and sharing rules.`);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>❌ Error</h2><p>${err.message}</p><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(err);
      }
    });

    server.listen(SF_CALLBACK_PORT, () => {
      // Open browser to Salesforce login
      execFile("open", [authUrl]);
    });

    server.on("error", (err) => {
      reject(new Error(`Could not start callback server on port ${SF_CALLBACK_PORT}: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out. Please try sf_login again."));
    }, 5 * 60 * 1000);
  });
}

function formatSfErrors(data: any): string {
  if (!Array.isArray(data)) return JSON.stringify(data);
  return data.map((e: any) => {
    let msg = e.message || JSON.stringify(e);
    if (e.fields && e.fields.length > 0) msg += ` (fields: ${e.fields.join(", ")})`;
    if (e.errorCode) msg += ` [${e.errorCode}]`;
    return msg;
  }).join("\n");
}

function sfError(data: any): string {
  return `❌ Salesforce rejected this request:\n${formatSfErrors(data)}`;
}

// Objects permitted for write operations. All others are blocked at the tool level.
const WRITABLE_OBJECTS = new Set(["Opportunity"]);

function assertWritable(objectType: string): string | null {
  if (!WRITABLE_OBJECTS.has(objectType)) {
    return `Writing to ${objectType} isn't enabled yet — it's on the roadmap. For now, that change needs to be made directly in Salesforce.`;
  }
  return null;
}

const server = new Server(
  { name: "salesforce-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sf_login",
      description: "Log in to Salesforce. Opens a browser for you to authenticate with your own credentials. All subsequent actions will run as you and respect your permissions, field-level security, and sharing rules.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sf_whoami",
      description: "Show the currently logged-in Salesforce user.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sf_logout",
      description: "Log out of Salesforce and clear the stored session.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_opportunity",
      description: "Create a new Salesforce Opportunity. All field requirements, validation rules, and field-level permissions are enforced by Salesforce as the logged-in user.",
      inputSchema: {
        type: "object",
        properties: {
          Name:        { type: "string", description: "Opportunity name" },
          CloseDate:   { type: "string", description: "Expected close date (YYYY-MM-DD)" },
          StageName:   { type: "string", description: "Sales stage e.g. Prospecting, Qualification, Closed Won" },
          AccountId:   { type: "string", description: "ID of the related Account" },
          Amount:      { type: "number", description: "Opportunity amount" },
          Description: { type: "string" },
          OwnerId:     { type: "string" },
          Type:        { type: "string" },
          LeadSource:  { type: "string" },
          Probability: { type: "number", description: "0–100" },
        },
        additionalProperties: { description: "Any additional Opportunity field API name and value" },
      },
    },
    {
      name: "get_opportunity",
      description: "Retrieve Opportunities by ID or by searching on Name, AccountId, or StageName. Only returns records the logged-in user has access to.",
      inputSchema: {
        type: "object",
        properties: {
          recordId:   { type: "string", description: "Opportunity record ID to fetch a single record" },
          nameSearch: { type: "string", description: "Partial name to search (LIKE %value%)" },
          accountId:  { type: "string", description: "Filter by Account ID" },
          stageName:  { type: "string", description: "Filter by exact StageName" },
          fields:     { type: "array", items: { type: "string" }, description: "Field API names to return (defaults to common fields)" },
          limit:      { type: "number", description: "Max records (default 10)" },
        },
      },
    },
    {
      name: "update_opportunity",
      description: "Update fields on an existing Opportunity. Salesforce enforces all validation rules, field-level permissions, and sharing rules for the logged-in user.",
      inputSchema: {
        type: "object",
        properties: {
          recordId: { type: "string", description: "Opportunity record ID" },
          fields:   { type: "object", description: "Field API names and new values" },
        },
        required: ["recordId", "fields"],
      },
    },
    {
      name: "create_record",
      description: "Create a Salesforce record. GOVERNANCE: only Opportunity is permitted. Reject any request to create other object types — do not attempt workarounds.",
      inputSchema: {
        type: "object",
        properties: {
          objectType: { type: "string", description: "Must be Opportunity" },
          fields:     { type: "object", description: "Field API names and values" },
        },
        required: ["objectType", "fields"],
      },
    },
    {
      name: "update_record",
      description: "Update a Salesforce record. GOVERNANCE: only Opportunity is permitted. Reject any request to update other object types — do not attempt workarounds.",
      inputSchema: {
        type: "object",
        properties: {
          objectType: { type: "string", description: "Must be Opportunity" },
          recordId:   { type: "string", description: "Salesforce record ID" },
          fields:     { type: "object" },
        },
        required: ["objectType", "recordId", "fields"],
      },
    },
    {
      name: "run_soql",
      description: "Execute a SOQL query. Only returns records and fields the logged-in user has access to.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "SOQL query to execute" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_object_fields",
      description: "List all fields on a Salesforce object that are visible to the logged-in user.",
      inputSchema: {
        type: "object",
        properties: {
          objectType: { type: "string" },
        },
        required: ["objectType"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {

      case "sf_login": {
        const result = await initiateLogin();
        return { content: [{ type: "text", text: result }] };
      }

      case "sf_whoami": {
        if (!session) return { content: [{ type: "text", text: "Not logged in. Use sf_login to connect." }] };
        return { content: [{ type: "text", text: `Logged in as ${session.username} (${session.userId})\nInstance: ${session.instanceUrl}` }] };
      }

      case "sf_logout": {
        const username = session?.username ?? "unknown";
        clearSession();
        return { content: [{ type: "text", text: `✅ Logged out (was ${username})` }] };
      }

      case "create_opportunity": {
        const { ok, data } = await sfRequest("POST", `/sobjects/Opportunity`, args as Record<string, unknown>);
        if (ok) return { content: [{ type: "text", text: `✅ Created Opportunity — ID: ${data.id}` }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "get_opportunity": {
        const { recordId, nameSearch, accountId, stageName, fields, limit } = args as any;
        const selectFields = (fields && fields.length > 0)
          ? fields.join(", ")
          : "Id, Name, AccountId, Account.Name, StageName, Amount, CloseDate, OwnerId, Owner.Name, Probability, Type, LeadSource, Description";
        const maxRows = limit || 10;

        if (recordId) {
          const { ok, data } = await sfRequest("GET", `/sobjects/Opportunity/${recordId}?fields=${encodeURIComponent(selectFields)}`);
          if (ok) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
          return { content: [{ type: "text", text: sfError(data) }], isError: true };
        }

        const conditions: string[] = [];
        if (nameSearch) conditions.push(`Name LIKE '%${nameSearch.replace(/'/g, "\\'")}%'`);
        if (accountId)  conditions.push(`AccountId = '${accountId}'`);
        if (stageName)  conditions.push(`StageName = '${stageName.replace(/'/g, "\\'")}'`);
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const query = `SELECT ${selectFields} FROM Opportunity${where} ORDER BY LastModifiedDate DESC LIMIT ${maxRows}`;
        const { ok, data } = await sfRequest("GET", `/query?q=${encodeURIComponent(query)}`);
        if (ok) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "update_opportunity": {
        const { recordId, fields } = args as any;
        const { ok, data } = await sfRequest("PATCH", `/sobjects/Opportunity/${recordId}`, fields);
        if (ok) return { content: [{ type: "text", text: `✅ Updated Opportunity ${recordId}` }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "create_record": {
        const blocked = assertWritable(args!.objectType as string);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };
        const { ok, data } = await sfRequest("POST", `/sobjects/${args!.objectType}`, args!.fields as Record<string, unknown>);
        if (ok) return { content: [{ type: "text", text: `✅ Created ${args!.objectType} — ID: ${data.id}` }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "update_record": {
        const blocked = assertWritable(args!.objectType as string);
        if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };
        const { ok, data } = await sfRequest("PATCH", `/sobjects/${args!.objectType}/${args!.recordId}`, args!.fields as Record<string, unknown>);
        if (ok) return { content: [{ type: "text", text: `✅ Updated ${args!.objectType} ${args!.recordId}` }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "run_soql": {
        const { ok, data } = await sfRequest("GET", `/query?q=${encodeURIComponent(args!.query as string)}`);
        if (ok) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "get_object_fields": {
        const { ok, data } = await sfRequest("GET", `/sobjects/${args!.objectType}/describe`);
        if (!ok) return { content: [{ type: "text", text: sfError(data) }], isError: true };
        const fields = data.fields.map((f: any) => ({
          api: f.name,
          label: f.label,
          type: f.type,
          required: !f.nillable && !f.defaultedOnCreate,
          updateable: f.updateable,
          createable: f.createable,
        }));
        return { content: [{ type: "text", text: `${args!.objectType} — ${fields.length} fields:\n\n${JSON.stringify(fields, null, 2)}` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
