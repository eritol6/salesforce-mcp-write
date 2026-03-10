import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

const SF_CLIENT_ID     = process.env.SF_CLIENT_ID!;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET!;
const SF_LOGIN_URL     = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const SF_API_VERSION   = process.env.SF_API_VERSION || "v60.0";

let accessToken: string | null = null;
let instanceUrl: string | null = null;

async function authenticate() {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    body: params,
  });
  if (!res.ok) throw new Error(`SF auth failed: ${await res.text()}`);
  const data = (await res.json()) as any;
  accessToken = data.access_token;
  instanceUrl = data.instance_url;
}

// Returns { ok, status, data } — never throws on SF API errors so callers can surface them.
async function sfRequest(method: string, path: string, body?: object): Promise<{ ok: boolean; status: number; data: any }> {
  if (!accessToken) await authenticate();
  const res = await fetch(`${instanceUrl}/services/data/${SF_API_VERSION}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    await authenticate();
    return sfRequest(method, path, body);
  }
  // 204 No Content (PATCH success) has no body
  if (res.status === 204) return { ok: true, status: 204, data: null };
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Formats Salesforce error arrays into readable messages.
// SF errors: [{ message, errorCode, fields }]
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

const server = new Server(
  { name: "salesforce-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_opportunity",
      description: `Create a new Salesforce Opportunity. All field requirements, validation rules, and field-level permissions are enforced by Salesforce — do not pre-validate on the client side. Pass whatever fields you have; Salesforce will return clear errors if anything is missing or invalid.`,
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
      description: "Retrieve Opportunities by ID or by searching on Name, AccountId, or StageName.",
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
      description: "Update fields on an existing Opportunity. Salesforce enforces all validation rules, field-level permissions, and required field rules — errors are returned as-is.",
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
      description: "Create a record in any Salesforce object. Salesforce enforces all permissions and validation rules.",
      inputSchema: {
        type: "object",
        properties: {
          objectType: { type: "string", description: "Salesforce object API name e.g. Account, Contact" },
          fields:     { type: "object", description: "Field API names and values" },
        },
        required: ["objectType", "fields"],
      },
    },
    {
      name: "update_record",
      description: "Update fields on any Salesforce record. Salesforce enforces all permissions and validation rules.",
      inputSchema: {
        type: "object",
        properties: {
          objectType: { type: "string" },
          recordId:   { type: "string", description: "Salesforce record ID" },
          fields:     { type: "object" },
        },
        required: ["objectType", "recordId", "fields"],
      },
    },
    {
      name: "run_soql",
      description: "Execute a SOQL query and return results. Only returns fields the connected user has read access to.",
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
      description: "List all fields on a Salesforce object that are visible to the current user.",
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
        const { ok, data } = await sfRequest("POST", `/sobjects/${args!.objectType}`, args!.fields as Record<string, unknown>);
        if (ok) return { content: [{ type: "text", text: `✅ Created ${args!.objectType} — ID: ${data.id}` }] };
        return { content: [{ type: "text", text: sfError(data) }], isError: true };
      }

      case "update_record": {
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
