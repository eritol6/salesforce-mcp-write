import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const SF_API_VERSION = process.env.SF_API_VERSION || "v60.0";
let accessToken = null;
let instanceUrl = null;
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
    if (!res.ok)
        throw new Error(`SF auth failed: ${await res.text()}`);
    const data = (await res.json());
    accessToken = data.access_token;
    instanceUrl = data.instance_url;
}
async function sfRequest(method, path, body) {
    if (!accessToken)
        await authenticate();
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
    const text = await res.text();
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
const server = new Server({ name: "salesforce-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "create_record",
            description: "Create a new record in any Salesforce object",
            inputSchema: {
                type: "object",
                properties: {
                    objectType: { type: "string", description: "Salesforce object API name e.g. Opportunity, Account, Contact" },
                    fields: { type: "object", description: "Field API names and values" },
                },
                required: ["objectType", "fields"],
            },
        },
        {
            name: "run_soql",
            description: "Execute a SOQL query and return results",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "SOQL query to execute" },
                },
                required: ["query"],
            },
        },
        {
            name: "update_record",
            description: "Update fields on an existing Salesforce record",
            inputSchema: {
                type: "object",
                properties: {
                    objectType: { type: "string" },
                    recordId: { type: "string", description: "18-char Salesforce record ID" },
                    fields: { type: "object" },
                },
                required: ["objectType", "recordId", "fields"],
            },
        },
        {
            name: "get_object_fields",
            description: "List all fields on a Salesforce object",
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
            case "create_record": {
                const result = await sfRequest("POST", `/sobjects/${args.objectType}`, args.fields);
                return { content: [{ type: "text", text: result.success ? `✅ Created ${args.objectType} — ID: ${result.id}` : `❌ Error: ${JSON.stringify(result)}` }] };
            }
            case "run_soql": {
                const result = await sfRequest("GET", `/query?q=${encodeURIComponent(args.query)}`);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            case "update_record": {
                await sfRequest("PATCH", `/sobjects/${args.objectType}/${args.recordId}`, args.fields);
                return { content: [{ type: "text", text: `✅ Updated ${args.objectType} ${args.recordId}` }] };
            }
            case "get_object_fields": {
                const result = await sfRequest("GET", `/sobjects/${args.objectType}/describe`);
                const fields = result.fields.map((f) => ({ api: f.name, label: f.label, type: f.type }));
                return { content: [{ type: "text", text: `${args.objectType} has ${fields.length} fields:\n\n${JSON.stringify(fields, null, 2)}` }] };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
