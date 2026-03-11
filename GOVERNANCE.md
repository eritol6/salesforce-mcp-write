# Salesforce MCP Governance — Project Catalyst

## Purpose

This file governs how Claude interacts with Salesforce via MCP tools. It enforces write permissions, confirmation protocols, and scoping rules to ensure safe, auditable Salesforce operations aligned with the Catalyst initiative.

Salesforce is the **system of record**. Every write must be intentional, confirmed, and traceable.

---

## Write Permissions

### Allowed Write Objects

Only the objects listed below may be created or updated. **All other objects are read-only.**

| Object | Create | Update | Notes |
|---|---|---|---|
| Opportunity | ✅ | ✅ | Phase 1 — primary focus |

<!--
ADDING A NEW WRITABLE OBJECT:
1. Add a row to the table above
2. Add a field set section under "Field Sets for Writable Objects" below
3. Add any object-specific validation rules
4. Review and test before enabling for end users
-->

### Read-Only (Everything Else)

All Salesforce objects not listed in the table above are **read-only**. Use `salesforce-admin` tools, `run_soql`, `get_object_fields`, and `get_opportunity` freely for reading and analysis.

**If a user requests a write operation on a non-allowed object:**
1. Do NOT execute the write
2. Respond: "Writing to [Object] isn't enabled yet — it's on the roadmap. For now, that change needs to be made directly in Salesforce. Want me to help with anything else?"
3. Do NOT offer workarounds that bypass this restriction

---

## Confirmation Protocol

**Every write operation (create or update) MUST be confirmed before execution.**

### Create Flow

1. Gather required fields from the user (see Field Sets below)
2. Present a summary of what will be created:
   ```
   I'll create this Opportunity:
   • Name: [value]
   • Account: [value]
   • Stage: [value]
   • Close Date: [value]
   • Amount: [value]
   • [any additional fields provided]

   Ready to create? (Yes / No / Edit)
   ```
3. Wait for explicit confirmation before calling `create_opportunity` or `create_record`
4. After creation, confirm success and return the Opportunity ID and a link if possible

### Update Flow

1. Confirm which Opportunity is being updated (retrieve and display current values)
2. Show a before/after comparison for the fields being changed:
   ```
   Updating Opportunity: [Name] ([Id])
   • Stage: Prospecting → Negotiation
   • Amount: $50,000 → $75,000

   Confirm update? (Yes / No / Edit)
   ```
3. Wait for explicit confirmation before calling `update_opportunity` or `update_record`
4. After update, confirm success and show the updated values

### Rules

- Never batch multiple unrelated writes into a single confirmation
- If the user says "just do it" or "skip confirmation," still confirm once — reply: "Got it, I'll keep it quick. Here's what I'm about to write: [summary]. Go?"
- If any required field is missing, ask for it before presenting the confirmation summary

---

## Field Sets for Writable Objects

### Opportunity — Create

**Required fields** (must be provided by the user or derived from context):

- Opportunity Name
- Account (Name or Id)
- Stage
- Close Date
- Amount

**Optional fields** (accept if provided, do not prompt unless relevant):

- Description
- Type
- Lead Source
- Next Step
- Probability (usually auto-set by Stage — only override if explicitly requested)

**System-set fields** (do not ask the user for these):

- OwnerId — set to the requesting user's Salesforce Id if known, otherwise ask
- CurrencyIsoCode — default to USD unless otherwise specified
- RecordTypeId — derive from context or ask if multiple record types exist

> **NOTE:** This field set is intentionally slim. As Catalyst matures and the
> Opportunity field simplification work progresses, revisit this list. Fields
> removed from the org should be removed here too. Fields validated by the org
> (e.g., picklist values for Stage) should be respected — query valid values
> before presenting options when possible.

### Opportunity — Update

**Any field on the Opportunity may be updated**, subject to:

- Field-level security on the integration user's profile
- Validation rules enforced by the org
- The confirmation protocol above

**High-sensitivity fields** — take extra care and always double-confirm:

- Stage (drives automation and forecasting)
- Amount (financial impact)
- Close Date (forecast impact)
- OwnerId (reassignment)

---

## Tool Usage Rules

### salesforce-write tools

| Tool | Allowed Usage |
|---|---|
| `create_opportunity` | Create Opportunity records only |
| `update_opportunity` | Update Opportunity records only |
| `create_record` | Opportunity object only — reject all other objects |
| `update_record` | Opportunity object only — reject all other objects |
| `get_opportunity` | Unrestricted (read) |
| `get_object_fields` | Unrestricted (read) |
| `run_soql` | Unrestricted (read) |
| `sf_login` / `sf_logout` | Session management — use as needed |
| `sf_whoami` | Unrestricted (read) |

### salesforce-admin tools

All 55 tools are **read-only by design**. Use freely for inspection, analysis, metadata review, and org health checks.

---

## Error Handling

- If a write fails, show the user the error message from Salesforce and suggest corrective action
- Do not retry a failed write automatically — present the error and let the user decide
- Common issues to watch for:
  - Required field missing (check org-level required fields, not just this doc's field set)
  - Invalid picklist value (query valid values with `get_object_fields` first)
  - Duplicate detection rules
  - Validation rule failures

---

## Attribution and Audit

- All writes are executed via the integration user's credentials (the MCP connection)
- When creating or updating records, include context about who requested the action:
  - If the requesting user is known, note their name in the Description or a designated field
  - Log the action in the conversation for traceability
- This attribution model will evolve as Catalyst matures — a dedicated "Requested By" field or Chatter post may replace this in future phases

---

## Phase Roadmap (Reference Only)

This section is informational. Only the "Allowed Write Objects" table above governs actual permissions.

- **Phase 1 (current):** Opportunity create and update
- **Phase 2 (planned):** Quote/Quote Line creation (pending CPQ/Agentforce architecture decision)
- **Phase 3 (planned):** Account and Contact updates
- **Future:** Task creation, Activity logging, custom object writes as needed

---

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-03-10 | Initial version — Phase 1: Opportunity create/update only | Eric |
